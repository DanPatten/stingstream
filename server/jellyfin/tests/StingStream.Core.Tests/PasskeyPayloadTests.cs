using System.Text;
using System.Text.Json;
using Fido2NetLib;
using StingStream.Core.Passkeys;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Reading a WebAuthn credential out of the JSON a browser produced.
/// </summary>
/// <remarks>
/// <para>
/// <b>These exist because the first version of this endpoint could not read a credential at all,
/// and nothing said so until a live node was in front of it.</b> The models were bound by
/// Jellyfin's serializer, which registers its own enum converters globally — and System.Text.Json
/// gives a converter in <c>options.Converters</c> precedence over one declared on a type, so the
/// library's own <c>EnumMember</c> spelling of <c>"public-key"</c> never got a look in. Every
/// ceremony died on the first field with a 400 naming a .NET type.
/// </para>
/// <para>
/// So the payloads below are the shapes <c>lib/stingstream/webauthn.ts</c> actually sends, and what
/// they pin is that the library's own rules are the ones in force: base64url byte arrays, and the
/// spec's spelling of the credential type.
/// </para>
/// </remarks>
public class PasskeyPayloadTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static string B64Url(string text)
        => System.Buffers.Text.Base64Url.EncodeToString(Encoding.UTF8.GetBytes(text));

    [Fact]
    public void AnAssertionInTheShapeTheAppSendsIsRead()
    {
        var payload = Json($$"""
            {
              "id": "{{B64Url("credential")}}",
              "rawId": "{{B64Url("credential")}}",
              "type": "public-key",
              "response": {
                "authenticatorData": "{{B64Url("auth-data")}}",
                "clientDataJSON": "{{B64Url("client-data")}}",
                "signature": "{{B64Url("signature")}}",
                "userHandle": "{{B64Url("user")}}"
              },
              "extensions": {},
              "clientExtensionResults": {}
            }
            """);

        var read = PasskeyPayload.Read<AuthenticatorAssertionRawResponse>(payload);

        Assert.NotNull(read);
        // The exact field the mixed-serializer version died on.
        Assert.Equal(Fido2NetLib.Objects.PublicKeyCredentialType.PublicKey, read!.Type);
        // And the encoding every binary field uses: base64url, not standard base64.
        Assert.Equal("credential", Encoding.UTF8.GetString(read.RawId));
        Assert.Equal("signature", Encoding.UTF8.GetString(read.Response.Signature));
        Assert.Equal("user", Encoding.UTF8.GetString(read.Response.UserHandle!));
    }

    [Fact]
    public void AnAbsentUserHandleIsNullRatherThanEmpty()
    {
        // The app sends null when the authenticator gave none, and the two mean different things:
        // empty would decode to zero bytes and be compared against a real user id.
        var payload = Json($$"""
            {
              "id": "{{B64Url("c")}}", "rawId": "{{B64Url("c")}}", "type": "public-key",
              "response": {
                "authenticatorData": "{{B64Url("a")}}",
                "clientDataJSON": "{{B64Url("d")}}",
                "signature": "{{B64Url("s")}}",
                "userHandle": null
              },
              "extensions": {}, "clientExtensionResults": {}
            }
            """);

        var read = PasskeyPayload.Read<AuthenticatorAssertionRawResponse>(payload);

        Assert.NotNull(read);
        Assert.Null(read!.Response.UserHandle);
    }

    [Fact]
    public void ARegistrationInTheShapeTheAppSendsIsRead()
    {
        var payload = Json($$"""
            {
              "id": "{{B64Url("credential")}}",
              "rawId": "{{B64Url("credential")}}",
              "type": "public-key",
              "response": {
                "attestationObject": "{{B64Url("attestation")}}",
                "clientDataJSON": "{{B64Url("client-data")}}",
                "transports": ["internal", "hybrid"]
              },
              "extensions": {},
              "clientExtensionResults": {}
            }
            """);

        var read = PasskeyPayload.Read<AuthenticatorAttestationRawResponse>(payload);

        Assert.NotNull(read);
        Assert.Equal("attestation", Encoding.UTF8.GetString(read!.Response.AttestationObject));
        Assert.Equal(2, read.Response.Transports!.Length);
    }

    [Fact]
    public void ARegistrationWithNoTransportsIsStillRead()
    {
        // Some older Safari builds have no `getTransports`, so the app sends an empty list. It has
        // to be present -- the field is required -- but empty is a legitimate value.
        var payload = Json($$"""
            {
              "id": "{{B64Url("c")}}", "rawId": "{{B64Url("c")}}", "type": "public-key",
              "response": {
                "attestationObject": "{{B64Url("a")}}",
                "clientDataJSON": "{{B64Url("d")}}",
                "transports": []
              },
              "extensions": {}, "clientExtensionResults": {}
            }
            """);

        Assert.NotNull(PasskeyPayload.Read<AuthenticatorAttestationRawResponse>(payload));
    }

    [Theory]
    [InlineData("null")]
    [InlineData("\"a string\"")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"id\": 5}")]
    public void AnythingElseIsNullRatherThanAnException(string raw)
    {
        // These endpoints are anonymous and on the sign-in path, so a body somebody made up has to
        // produce the same sentence as a passkey that does not verify — not a 500 and a stack
        // trace in the log for anyone who can reach the server.
        Assert.Null(PasskeyPayload.Read<AuthenticatorAssertionRawResponse>(Json(raw)));
    }

    [Fact]
    public void StandardBase64IsNotQuietlyAccepted()
    {
        // `+` and `/` are exactly what base64url replaces, and a value carrying them is not what
        // the browser produced. Accepting it would mean the two ends disagree about the encoding
        // on roughly one credential in twenty — the ones whose bytes happen to hit those
        // characters — which is the worst possible failure rate to debug.
        var payload = Json("""
            {
              "id": "a+b/c", "rawId": "a+b/c", "type": "public-key",
              "response": {
                "authenticatorData": "a+b/c==",
                "clientDataJSON": "a+b/c==",
                "signature": "a+b/c=="
              },
              "extensions": {}, "clientExtensionResults": {}
            }
            """);

        Assert.Null(PasskeyPayload.Read<AuthenticatorAssertionRawResponse>(payload));
    }
}
