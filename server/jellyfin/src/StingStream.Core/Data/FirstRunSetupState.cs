using System.Threading;
using System.Threading.Tasks;

namespace StingStream.Core.Data;

/// <summary>
/// Whether this node is still waiting for somebody to create the first account.
/// </summary>
/// <remarks>
/// <para>
/// A document in the existing <c>settings</c> table rather than a column of its own:
/// <see cref="SettingsStore.GetDocument{T}"/> and <see cref="SettingsStore.PutDocumentAsync{T}"/>
/// already give a typed key/value store over it, so this needs no DDL and
/// <see cref="CoreDatabase.SchemaVersion"/> stays where it is.
/// </para>
/// <para>
/// Set when first-run wiring creates the bootstrap administrator, and cleared by whichever comes
/// first: a successful <c>POST /stingstream/api/v1/setup/admin</c>, or the account signing in on
/// its own (which is what somebody who read the generated password out of <c>runtime.json</c>
/// does). While it is set, a caller on this machine may claim the administrator account without
/// authenticating — which is exactly the first-run screen, and exactly why the flag must not
/// outlive it.
/// </para>
/// </remarks>
public sealed class FirstRunSetupState
{
    /// <summary>Settings key this document is stored under in <c>core.db</c>.</summary>
    public const string StorageKey = "first-run-setup";

    /// <summary>True while the first account has still to be created.</summary>
    public bool Pending { get; set; }

    /// <summary>The account that claimed this server at first run, in <c>N</c> format.</summary>
    /// <remarks>
    /// <b>The owner, and it never moves.</b> Dan: <em>"cannot be changed and is the first admin
    /// setup, no transfer support and they are always an admin"</em>. Recorded the moment
    /// <c>setup/admin</c> claims the bootstrap account, because that is the only moment anything
    /// knows which account it was: <c>IUserManager.GetFirstUser</c> is an unordered
    /// <c>FirstOrDefault</c>, so it happens to answer correctly today and is not something to build
    /// a permanent fact on.
    /// <para>
    /// Empty on a node set up before this existed. <see cref="FirstRun.SetupGate.ChooseOwner"/>
    /// falls back to the first account there and it is then written down, so the answer stops being
    /// a guess after the first time anybody asks.
    /// </para>
    /// </remarks>
    public string OwnerUserId { get; set; } = string.Empty;

    /// <summary>
    /// The stored document, or a not-pending default when the node has never written one.
    /// </summary>
    /// <param name="settings">The settings store.</param>
    /// <returns>The stored state, never <see langword="null"/>.</returns>
    /// <remarks>
    /// Defaults to <em>not</em> pending, which is the safe direction: a node upgraded from a build
    /// that predates this flag already has an account somebody chose, and must not offer to hand
    /// it to the next caller on loopback.
    /// </remarks>
    public static FirstRunSetupState Get(SettingsStore settings)
        => settings?.GetDocument<FirstRunSetupState>(StorageKey) ?? new FirstRunSetupState();

    /// <summary>Whether the node has ever written this document.</summary>
    /// <param name="settings">The settings store.</param>
    /// <returns>True when a row exists.</returns>
    public static bool Exists(SettingsStore settings)
        => settings?.GetDocument<FirstRunSetupState>(StorageKey) is not null;

    /// <summary>Record whether setup is still pending.</summary>
    /// <param name="settings">The settings store.</param>
    /// <param name="pending">The new value.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// Read before it is written, because this document now holds a second thing. Rebuilding it
    /// from the one field the caller knows about would drop <see cref="OwnerUserId"/> — and the
    /// call that closes setup runs immediately after the call that records the owner.
    /// </remarks>
    public static Task SetAsync(SettingsStore settings, bool pending, CancellationToken cancellationToken = default)
    {
        var current = Get(settings);
        current.Pending = pending;
        return settings.PutDocumentAsync(StorageKey, current, cancellationToken);
    }

    /// <summary>Record which account owns this server. Only ever written once.</summary>
    /// <param name="settings">The settings store.</param>
    /// <param name="ownerUserId">The account, in <c>N</c> format.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    /// <remarks>
    /// <b>Refuses to overwrite an owner that is already recorded.</b> There is no transfer, so the
    /// only ways this could be called twice are a repeated first run or a bug, and both should
    /// leave the original answer standing.
    /// </remarks>
    public static Task SetOwnerAsync(
        SettingsStore settings,
        string ownerUserId,
        CancellationToken cancellationToken = default)
    {
        var current = Get(settings);
        if (!string.IsNullOrWhiteSpace(current.OwnerUserId)
            || string.IsNullOrWhiteSpace(ownerUserId))
        {
            return Task.CompletedTask;
        }

        current.OwnerUserId = ownerUserId.Trim();
        return settings.PutDocumentAsync(StorageKey, current, cancellationToken);
    }
}
