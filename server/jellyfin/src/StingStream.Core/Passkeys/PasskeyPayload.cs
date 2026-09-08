using System.Text.Json;
using Fido2NetLib;

namespace StingStream.Core.Passkeys;

/// <summary>
/// Reading what the browser sent, with the WebAuthn library's own rules rather than Jellyfin's.
/// </summary>
/// <remarks>
/// <para>
/// <b>This exists because mixing the two serializers is a real bug, and one that is invisible until
/// a browser is in front of it.</b> Fido2NetLib's response types are annotated for a plain
/// serializer — <c>[JsonConverter(Base64UrlConverter)]</c> on every byte array, and an
/// <c>EnumMember</c> spelling of <c>"public-key"</c> on the credential type. Jellyfin's serializer
/// is configured for a decade of Jellyfin clients and registers its own enum converters in
/// <c>options.Converters</c>, and System.Text.Json gives those precedence over a converter declared
/// on a type. So binding those models through Jellyfin's serializer fails on the very first field,
/// with a 400 that names a .NET type nobody in a browser has heard of.
/// </para>
/// <para>
/// The controller therefore takes the credential as a <see cref="JsonElement"/> — raw, unbound,
/// unvalidated — and this is where it becomes a typed response. One seam, and both configurations
/// stay where they belong.
/// </para>
/// </remarks>
public static class PasskeyPayload
{
    /// <summary>
    /// The serializer the WebAuthn models were written for: attributes honoured, nothing global.
    /// </summary>
    private static readonly JsonSerializerOptions _options = new(JsonSerializerDefaults.Web);

    /// <summary>Read a WebAuthn response out of raw JSON.</summary>
    /// <typeparam name="T">The response type.</typeparam>
    /// <param name="credential">What the client posted, verbatim.</param>
    /// <returns>The parsed response, or <see langword="null"/> when it is not one.</returns>
    /// <remarks>
    /// Null rather than an exception for anything malformed. These are anonymous endpoints on the
    /// sign-in path: a body somebody made up should produce the same sentence as a passkey that
    /// does not verify, not a 500 in the log and a stack trace to read.
    /// </remarks>
    public static T? Read<T>(JsonElement credential)
        where T : class
    {
        if (credential.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        try
        {
            var parsed = credential.Deserialize<T>(_options);
            return parsed is not null && IsUsable(parsed) ? parsed : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Whether a parsed response actually carries the parts a ceremony needs.</summary>
    /// <param name="parsed">What came out of the deserializer.</param>
    /// <returns>True when it is usable.</returns>
    /// <remarks>
    /// <para>
    /// <b>Parsing is not the same as being complete, and the gap is a crash.</b> Fido2NetLib marks
    /// the outer fields with DataAnnotations <c>[Required]</c>, which System.Text.Json does not
    /// enforce — only the nested <c>required</c> members are, and those are never reached when the
    /// nested object itself is absent. So <c>{}</c> deserializes happily into a response whose
    /// every field is null, and the first thing the caller does with it is read <c>RawId</c>.
    /// </para>
    /// <para>
    /// These endpoints are anonymous, so that null dereference is reachable by anybody who can post
    /// an empty object at the server. Checked here rather than in the callers because there is one
    /// place to forget it here and two there.
    /// </para>
    /// </remarks>
    private static bool IsUsable(object parsed) => parsed switch
    {
        AuthenticatorAssertionRawResponse assertion =>
            assertion.RawId is { Length: > 0 }
            && assertion.Response is { } response
            && response.AuthenticatorData is { Length: > 0 }
            && response.ClientDataJson is { Length: > 0 }
            && response.Signature is { Length: > 0 },

        AuthenticatorAttestationRawResponse attestation =>
            attestation.RawId is { Length: > 0 }
            && attestation.Response is { } created
            && created.AttestationObject is { Length: > 0 }
            && created.ClientDataJson is { Length: > 0 },

        _ => true,
    };
}
