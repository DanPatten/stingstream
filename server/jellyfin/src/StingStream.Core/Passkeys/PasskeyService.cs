using System;
using System.Buffers.Text;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Fido2NetLib;
using Fido2NetLib.Objects;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;
using StingStream.Core.Mesh;

namespace StingStream.Core.Passkeys;

/// <summary>
/// Passkeys, on this server, bound to this server's own domain.
/// </summary>
/// <remarks>
/// <para>
/// <b>In C# rather than in the mesh, and that is not an implementation detail.</b> The version that
/// was deleted used <c>webauthn-rs</c>, which reaches OpenSSL through <c>webauthn-rs-core</c> and
/// does not build on a stock Windows toolchain from either the system or vendored sources — which
/// is why it had to sit behind a Cargo feature that was off by default, and why a Windows node
/// could never have had passkeys at all. Fido2NetLib is pure .NET over libsodium, which ships
/// prebuilt for every platform a node runs on, so this one simply works everywhere.
/// </para>
/// <para>
/// <b>Nothing here is required.</b> A password always works. Passkeys are drawn only when this
/// server has a domain to bind them to (<see cref="PasskeyOrigin"/>), and every entry point below
/// answers "not supported" rather than throwing when it does not.
/// </para>
/// </remarks>
public sealed class PasskeyService
{
    /// <summary>What the browser is told this server is called during a ceremony.</summary>
    private const string DisplayName = "StingStream";

    private static readonly JsonSerializerOptions _json = new();


    private readonly PasskeyStore _store;
    private readonly PasskeyCeremonies _ceremonies;
    private readonly IUserManager _users;
    private readonly IMeshClient _mesh;
    private readonly ILogger<PasskeyService> _logger;

    public PasskeyService(
        PasskeyStore store,
        PasskeyCeremonies ceremonies,
        IUserManager users,
        IMeshClient mesh,
        ILogger<PasskeyService> logger)
    {
        _store = store;
        _ceremonies = ceremonies;
        _users = users;
        _mesh = mesh;
        _logger = logger;
    }

    /// <summary>Whether this server can offer passkeys at all, and what they bind to.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The support answer and the relying party.</returns>
    public async Task<(PasskeySupport Support, PasskeyRelyingParty? Party)> SupportAsync(
        CancellationToken cancellationToken)
    {
        try
        {
            var settings = await _mesh.SharingSettingsAsync(cancellationToken).ConfigureAwait(false);
            return PasskeyOrigin.For(settings?.PublicAddress);
        }
        catch (Exception ex)
        {
            // The mesh being unreachable is not "no passkeys" -- it is "we cannot say" -- but the
            // only safe thing to draw is the password form, and that is what NoAddress produces.
            _logger.LogWarning(ex, "Could not read this node's address; reporting passkeys unsupported");
            return (PasskeySupport.NoAddress, null);
        }
    }

    /// <summary>The passkeys one account holds.</summary>
    /// <param name="userId">The Jellyfin user id.</param>
    /// <param name="party">The relying party in force, or null.</param>
    /// <returns>The list, newest first.</returns>
    public IReadOnlyList<PasskeySummary> ForUser(string userId, PasskeyRelyingParty? party)
        => _store.ForUser(userId)
            .Select(row => new PasskeySummary
            {
                Id = row.CredentialId,
                Label = row.Label,
                CreatedAt = row.CreatedAt.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                LastUsedAt = row.LastUsedAt?.ToString("O", System.Globalization.CultureInfo.InvariantCulture),
                // A passkey made for an address this server no longer answers to cannot be used --
                // the browser will not offer it -- and saying so is the difference between "my
                // passkey stopped working" and "I changed my domain".
                Usable = party is { } p && string.Equals(row.RelyingParty, p.Domain, StringComparison.OrdinalIgnoreCase),
                RelyingParty = row.RelyingParty,
            })
            .ToArray();

    /// <summary>Begin registering a passkey for an account that is already signed in.</summary>
    /// <param name="user">The account.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The ceremony, or a sentence saying why not.</returns>
    /// <remarks>
    /// A session is required, and that is the whole authorization: registering adds a second way
    /// into an account, so it takes somebody who has already proved they hold the first.
    /// </remarks>
    public async Task<(PasskeyChallenge? Challenge, string? Problem)> BeginRegistrationAsync(
        User user,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(user);

        var (support, party) = await SupportAsync(cancellationToken).ConfigureAwait(false);
        if (party is not { } rp)
        {
            return (null, PasskeyOrigin.Explain(support));
        }

        var userId = user.Id.ToString("N");

        // The user handle is Jellyfin's own id, so a discoverable credential answers with something
        // this server can resolve without being told a username. Everything this account already has
        // is excluded, so an authenticator that holds one offers to replace it rather than silently
        // making a second.
        var options = NewCredentialOptions(
            rp,
            userId,
            user.Username,
            _store.ForUser(userId)
                .Select(row => new PublicKeyCredentialDescriptor(Base64Url.DecodeFromChars(row.CredentialId)))
                .ToList());

        var ceremony = _ceremonies.Remember(options.ToJson(), userId, DateTimeOffset.UtcNow);
        if (ceremony is null)
        {
            return (null, "Too many sign-in attempts are in flight. Try again in a moment.");
        }

        return (new PasskeyChallenge { Ceremony = ceremony, Options = Wrap(options.ToJson()) }, null);
    }

    /// <summary>Finish registering a passkey.</summary>
    /// <param name="user">The account, from the session.</param>
    /// <param name="ceremonyId">The ceremony id from `begin`.</param>
    /// <param name="attestation">What the authenticator produced, as raw JSON.</param>
    /// <param name="label">What to call it.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A sentence when it failed, null when it worked.</returns>
    public async Task<string?> FinishRegistrationAsync(
        User user,
        string? ceremonyId,
        JsonElement attestation,
        string? label,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(user);
        if (PasskeyPayload.Read<AuthenticatorAttestationRawResponse>(attestation) is not { } response)
        {
            return "That passkey could not be read.";
        }

        var (_, party) = await SupportAsync(cancellationToken).ConfigureAwait(false);
        if (party is not { } rp)
        {
            return "Passkeys are not available on this server.";
        }

        var pending = _ceremonies.Take(ceremonyId, DateTimeOffset.UtcNow);
        if (pending is not { } ceremony)
        {
            return "That took too long. Try again.";
        }

        var userId = user.Id.ToString("N");
        // The account comes from the session, and the ceremony records which account it was issued
        // to. They have to be the same one: without this, a session for A could finish a ceremony
        // begun for B and register a passkey that signs in as B.
        if (!string.Equals(ceremony.UserId, userId, StringComparison.Ordinal))
        {
            _logger.LogWarning("A passkey registration was finished by a different account than it was begun for");
            return "That took too long. Try again.";
        }

        var credential = await VerifyAsync(rp, ceremony, response, cancellationToken).ConfigureAwait(false);
        if (credential is null)
        {
            return "That passkey could not be verified.";
        }

        await SaveAsync(credential, user, handle: null, rp, label, cancellationToken).ConfigureAwait(false);
        _logger.LogInformation("Registered a passkey for {User}", user.Username);
        return null;
    }

    /// <summary>Begin making a passkey for an account that an invite is about to create.</summary>
    /// <param name="inviteId">The invite, already judged valid.</param>
    /// <param name="username">The name, already judged usable and free.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The ceremony, or a sentence saying why not.</returns>
    /// <remarks>
    /// <para>
    /// <b>Nothing is created here.</b> The account is made only when the ceremony is finished, so a
    /// prompt somebody dismisses leaves no account behind and the invite still unspent.
    /// </para>
    /// <para>
    /// Which means there is no account id for the user handle, and the handle cannot be changed once
    /// the authenticator has stored it. So a random one is minted and recorded on the row
    /// (<see cref="PasskeyRow.UserHandle"/>); sign-in compares against it through
    /// <see cref="HandleFor"/>.
    /// </para>
    /// </remarks>
    public async Task<(PasskeyChallenge? Challenge, string? Problem)> BeginSignUpAsync(
        string inviteId,
        string username,
        CancellationToken cancellationToken)
    {
        var (support, party) = await SupportAsync(cancellationToken).ConfigureAwait(false);
        if (party is not { } rp)
        {
            return (null, PasskeyOrigin.Explain(support));
        }

        var handle = Guid.NewGuid().ToString("N");
        var options = NewCredentialOptions(rp, handle, username, new List<PublicKeyCredentialDescriptor>());
        var ceremony = _ceremonies.Remember(options.ToJson(), handle, DateTimeOffset.UtcNow, inviteId, username);
        if (ceremony is null)
        {
            return (null, "Too many sign-in attempts are in flight. Try again in a moment.");
        }

        return (new PasskeyChallenge { Ceremony = ceremony, Options = Wrap(options.ToJson()) }, null);
    }

    /// <summary>Verify the passkey made for an invite sign-up, without saving it.</summary>
    /// <param name="ceremonyId">The ceremony id from <see cref="BeginSignUpAsync"/>.</param>
    /// <param name="attestation">What the authenticator produced, as raw JSON.</param>
    /// <param name="inviteId">The invite this finish claims to be for.</param>
    /// <param name="username">The name this finish claims to be for.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The verified sign-up, or a sentence saying why not.</returns>
    /// <remarks>
    /// Not saved, because the account it belongs to is created after this answers and only if it
    /// answers yes. <see cref="SaveSignUpAsync"/> writes it once the account exists.
    /// </remarks>
    public async Task<(PasskeySignUp? SignUp, string? Problem)> VerifySignUpAsync(
        string? ceremonyId,
        JsonElement attestation,
        string inviteId,
        string username,
        CancellationToken cancellationToken)
    {
        if (PasskeyPayload.Read<AuthenticatorAttestationRawResponse>(attestation) is not { } response)
        {
            return (null, "That passkey could not be read.");
        }

        var (_, party) = await SupportAsync(cancellationToken).ConfigureAwait(false);
        if (party is not { } rp)
        {
            return (null, "Passkeys are not available on this server.");
        }

        var pending = _ceremonies.Take(ceremonyId, DateTimeOffset.UtcNow);
        if (pending is not { } ceremony || !SignUpMatches(ceremony, inviteId, username))
        {
            return (null, "That took too long. Try again.");
        }

        var credential = await VerifyAsync(rp, ceremony, response, cancellationToken).ConfigureAwait(false);
        return credential is null
            ? (null, "That passkey could not be verified.")
            : (new PasskeySignUp(credential, ceremony.UserId!, rp), null);
    }

    /// <summary>Save a verified sign-up passkey against the account the invite created.</summary>
    /// <param name="signUp">What <see cref="VerifySignUpAsync"/> returned.</param>
    /// <param name="user">The account, now that it exists.</param>
    /// <param name="label">What to call it.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task SaveSignUpAsync(
        PasskeySignUp signUp,
        User user,
        string? label,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(signUp);
        ArgumentNullException.ThrowIfNull(user);
        await SaveAsync(signUp.Credential, user, signUp.Handle, signUp.Party, label, cancellationToken)
            .ConfigureAwait(false);
        _logger.LogInformation("Registered a passkey for {User} while accepting an invite", user.Username);
    }

    /// <summary>Whether a sign-up ceremony is being finished for the invite and name it was begun for.</summary>
    /// <param name="ceremony">The ceremony, as it was remembered.</param>
    /// <param name="inviteId">The invite the finish names.</param>
    /// <param name="username">The name the finish names.</param>
    /// <returns>True when both match.</returns>
    /// <remarks>
    /// The name compares case-insensitively, as Jellyfin's own uniqueness check does, and is the
    /// trimmed form the controller passes to both calls.
    /// </remarks>
    public static bool SignUpMatches(PasskeyCeremony ceremony, string? inviteId, string? username)
        => ceremony.InviteId is not null
            && ceremony.UserId is not null
            && string.Equals(ceremony.InviteId, inviteId, StringComparison.Ordinal)
            && string.Equals(ceremony.Username, username, StringComparison.OrdinalIgnoreCase);

    /// <summary>The user handle a stored passkey's authenticator holds.</summary>
    /// <param name="row">The stored passkey.</param>
    /// <returns>The recorded handle, or the account id when none was recorded.</returns>
    public static string HandleFor(PasskeyRow row)
    {
        ArgumentNullException.ThrowIfNull(row);
        return string.IsNullOrEmpty(row.UserHandle) ? row.UserId : row.UserHandle;
    }

    private static CredentialCreateOptions NewCredentialOptions(
        PasskeyRelyingParty rp,
        string handle,
        string username,
        IReadOnlyList<PublicKeyCredentialDescriptor> exclude)
        => Build(rp).RequestNewCredential(new RequestNewCredentialParams
        {
            User = new Fido2User
            {
                Id = Encoding.UTF8.GetBytes(handle),
                Name = username,
                DisplayName = username,
            },
            ExcludeCredentials = exclude,
            AuthenticatorSelection = new AuthenticatorSelection
            {
                // Discoverable, because sign-in has no username to go on: the point of the button
                // is that you press it and you are in.
                ResidentKey = ResidentKeyRequirement.Required,
                UserVerification = UserVerificationRequirement.Required,
            },
            AttestationPreference = AttestationConveyancePreference.None,
        });

    private async Task<RegisteredPublicKeyCredential?> VerifyAsync(
        PasskeyRelyingParty rp,
        PasskeyCeremony ceremony,
        AuthenticatorAttestationRawResponse response,
        CancellationToken cancellationToken)
    {
        try
        {
            var made = await Build(rp).MakeNewCredentialAsync(
                new MakeNewCredentialParams
                {
                    AttestationResponse = response,
                    OriginalOptions = CredentialCreateOptions.FromJson(ceremony.Options),
                    IsCredentialIdUniqueToUserCallback = (args, _) =>
                        Task.FromResult(!_store.Exists(Base64Url.EncodeToString(args.CredentialId))),
                },
                cancellationToken).ConfigureAwait(false);
            return made
                ?? throw new InvalidOperationException("A verified registration has no credential.");
        }
        catch (Fido2VerificationException ex)
        {
            _logger.LogWarning(ex, "A passkey registration failed verification");
            return null;
        }
    }

    private Task SaveAsync(
        RegisteredPublicKeyCredential credential,
        User user,
        string? handle,
        PasskeyRelyingParty rp,
        string? label,
        CancellationToken cancellationToken)
        => _store.SaveAsync(
            new PasskeyRow
            {
                CredentialId = Base64Url.EncodeToString(credential.Id),
                UserId = user.Id.ToString("N"),
                UserHandle = handle,
                RelyingParty = rp.Domain,
                PublicKey = credential.PublicKey,
                SignCount = credential.SignCount,
                Transports = JsonSerializer.Serialize(
                    credential.Transports?.Select(t => t.ToString()) ?? Enumerable.Empty<string>(),
                    _json),
                BackupEligible = credential.IsBackupEligible,
                BackedUp = credential.IsBackedUp,
                Aaguid = credential.AaGuid.ToString(),
                Label = string.IsNullOrWhiteSpace(label) ? "Passkey" : label.Trim(),
                CreatedAt = DateTimeOffset.UtcNow,
            },
            cancellationToken);

    /// <summary>Begin signing in with a passkey. No username, by design.</summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The ceremony, or a sentence saying why not.</returns>
    /// <remarks>
    /// `AllowCredentials` is deliberately empty. The credentials are discoverable, so the
    /// authenticator already knows which ones it holds for this domain and offers them itself —
    /// which is both the nicer flow (press the button, you are in) and the one that does not
    /// answer "does an account called X exist here" to an anonymous caller.
    /// </remarks>
    public async Task<(PasskeyChallenge? Challenge, string? Problem)> BeginLoginAsync(
        CancellationToken cancellationToken)
    {
        var (support, party) = await SupportAsync(cancellationToken).ConfigureAwait(false);
        if (party is not { } rp)
        {
            return (null, PasskeyOrigin.Explain(support));
        }

        var options = Build(rp).GetAssertionOptions(new GetAssertionOptionsParams
        {
            AllowedCredentials = Array.Empty<PublicKeyCredentialDescriptor>(),
            UserVerification = UserVerificationRequirement.Required,
        });

        var ceremony = _ceremonies.Remember(options.ToJson(), null, DateTimeOffset.UtcNow);
        if (ceremony is null)
        {
            return (null, "Too many sign-in attempts are in flight. Try again in a moment.");
        }

        return (new PasskeyChallenge { Ceremony = ceremony, Options = Wrap(options.ToJson()) }, null);
    }

    /// <summary>Finish signing in with a passkey.</summary>
    /// <param name="ceremonyId">The ceremony id from `begin`.</param>
    /// <param name="credential">What the authenticator produced, as raw JSON.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The account it signed in, or a sentence saying why not.</returns>
    /// <remarks>
    /// <para>
    /// <b>The counter is handed in and written back.</b> The verifier compares the counter inside
    /// this assertion against the one from the credential's <em>last</em> use, so
    /// <see cref="PasskeyStore.UpdateCounterAsync"/> is not bookkeeping — it is the whole of clone
    /// detection. See its remarks for the version of this that shipped broken.
    /// </para>
    /// </remarks>
    public async Task<(User? User, string? Problem)> FinishLoginAsync(
        string? ceremonyId,
        JsonElement credential,
        CancellationToken cancellationToken)
    {
        if (PasskeyPayload.Read<AuthenticatorAssertionRawResponse>(credential) is not { } response)
        {
            return (null, "That passkey could not be read.");
        }

        var (_, party) = await SupportAsync(cancellationToken).ConfigureAwait(false);
        if (party is not { } rp)
        {
            return (null, "Passkeys are not available on this server.");
        }

        var pending = _ceremonies.Take(ceremonyId, DateTimeOffset.UtcNow);
        if (pending is not { } ceremony)
        {
            return (null, "That took too long. Try again.");
        }

        var credentialId = Base64Url.EncodeToString(response.RawId);
        var stored = _store.ByCredentialId(credentialId);
        if (stored is null
            || !string.Equals(stored.RelyingParty, rp.Domain, StringComparison.OrdinalIgnoreCase))
        {
            // Either nobody registered it, or it was registered against an address this server no
            // longer answers to. One message for both: an anonymous caller learns nothing about
            // which, and the person holding the passkey is told the useful half by the list on
            // their own settings screen.
            return (null, "That passkey is not registered on this server.");
        }

        VerifyAssertionResult verified;
        try
        {
            verified = await Build(rp).MakeAssertionAsync(
                new MakeAssertionParams
                {
                    AssertionResponse = response,
                    OriginalOptions = AssertionOptions.FromJson(ceremony.Options),
                    StoredPublicKey = stored.PublicKey,
                    // The counter from the last successful assertion, not from registration.
                    StoredSignatureCounter = stored.SignCount,
                    IsUserHandleOwnerOfCredentialIdCallback = (args, _) =>
                        Task.FromResult(
                            string.Equals(
                                Encoding.UTF8.GetString(args.UserHandle),
                                HandleFor(stored),
                                StringComparison.Ordinal)),
                },
                cancellationToken).ConfigureAwait(false);
        }
        catch (Fido2VerificationException ex)
        {
            // This is where a cloned authenticator lands: a counter that did not advance is a
            // verification failure, not a mismatch to be tolerated.
            _logger.LogWarning(ex, "A passkey sign-in failed verification");
            return (null, "That passkey could not be verified.");
        }

        await _store.UpdateCounterAsync(
            credentialId,
            verified.SignCount,
            verified.IsBackedUp,
            DateTimeOffset.UtcNow,
            cancellationToken).ConfigureAwait(false);

        if (!Guid.TryParse(stored.UserId, out var id) || _users.GetUserById(id) is not { } user)
        {
            // The account was deleted with its passkeys still in the table. Clean up rather than
            // leave a credential that names nobody.
            await _store.DeleteAsync(credentialId, stored.UserId, cancellationToken).ConfigureAwait(false);
            return (null, "That passkey is not registered on this server.");
        }

        if (user.HasPermission(PermissionKind.IsDisabled))
        {
            return (null, "That account is disabled.");
        }

        return (user, null);
    }

    /// <summary>Rename a passkey.</summary>
    public Task<bool> RenameAsync(string id, string userId, string label, CancellationToken cancellationToken)
        => _store.RenameAsync(id, userId, string.IsNullOrWhiteSpace(label) ? "Passkey" : label.Trim(), cancellationToken);

    /// <summary>Remove a passkey. Only its owner can.</summary>
    public Task<bool> DeleteAsync(string id, string userId, CancellationToken cancellationToken)
        => _store.DeleteAsync(id, userId, cancellationToken);

    /// <summary>A configured verifier for one relying party.</summary>
    /// <remarks>
    /// Built per call rather than injected, because the domain is a setting somebody can change
    /// while the server is running — and a verifier holding the old one would reject every
    /// ceremony afterwards with an origin mismatch, until a restart nobody would connect to the
    /// setting they had just edited.
    /// </remarks>
    private static IFido2 Build(PasskeyRelyingParty rp) => new Fido2(new Fido2Configuration
    {
        ServerDomain = rp.Domain,
        ServerName = DisplayName,
        Origins = new HashSet<string>(StringComparer.Ordinal) { rp.Origin },
    });

    /// <summary>
    /// Wrap the library's options JSON in the `{publicKey: …}` envelope the browser API takes.
    /// </summary>
    /// <remarks>
    /// The client (`lib/stingstream/webauthn.ts`) decodes `options.publicKey` and passes everything
    /// it does not recognise straight through to `navigator.credentials`, so this stays a
    /// pass-through: a field Fido2NetLib starts emitting tomorrow arrives without a change at
    /// either end. Parsed and re-serialised rather than string-concatenated so a malformed
    /// envelope is impossible.
    /// </remarks>
    private static JsonElement Wrap(string optionsJson)
    {
        using var document = JsonDocument.Parse(
            $"{{\"publicKey\":{optionsJson}}}");
        return document.RootElement.Clone();
    }
}

/// <summary>A verified passkey for an account an invite is about to create.</summary>
/// <param name="Credential">The verified credential.</param>
/// <param name="Handle">The user handle the authenticator holds.</param>
/// <param name="Party">The relying party it was verified against.</param>
public sealed record PasskeySignUp(
    RegisteredPublicKeyCredential Credential,
    string Handle,
    PasskeyRelyingParty Party);

/// <summary>A challenge, and the id to carry it back with.</summary>
public sealed class PasskeyChallenge
{
    /// <summary>The id the `finish` call must present.</summary>
    public string Ceremony { get; set; } = string.Empty;

    /// <summary>The WebAuthn options, in the `{publicKey: …}` envelope.</summary>
    public JsonElement Options { get; set; }
}

/// <summary>One registered passkey, as its owner sees it.</summary>
public sealed class PasskeySummary
{
    /// <summary>The credential id, base64url.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>What its owner called it.</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>When it was registered, ISO 8601.</summary>
    public string CreatedAt { get; set; } = string.Empty;

    /// <summary>When it last signed in, ISO 8601, or null.</summary>
    public string? LastUsedAt { get; set; }

    /// <summary>False when it was made for an address this server no longer answers to.</summary>
    public bool Usable { get; set; }

    /// <summary>The domain it was made for.</summary>
    public string RelyingParty { get; set; } = string.Empty;
}
