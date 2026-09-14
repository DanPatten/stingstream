using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using StingStream.Core.Configuration;
using StingStream.Core.Data;
using StingStream.Core.Passkeys;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// Creating an account from an invite with a passkey, where the credential is made before the
/// account it belongs to exists.
/// </summary>
/// <remarks>
/// The ceremony itself needs a browser. What can be checked here is what makes it safe: a sign-up
/// ceremony finishes only for the invite and name it was begun for, and a passkey whose handle is not
/// its account id still resolves at sign-in, while every older row keeps resolving the way it did.
/// </remarks>
public sealed class PasskeySignUpTests : IDisposable
{
    private readonly string _dir;
    private readonly CoreDatabase _db;

    public PasskeySignUpTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "stingstream-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
        _db = new CoreDatabase(NullLogger<CoreDatabase>.Instance, new FixedDataDirectory(_dir));
    }

    [Fact]
    public void ASignUpCeremonyCarriesItsInviteAndName()
    {
        var ceremonies = new PasskeyCeremonies();
        var id = ceremonies.Remember("{}", "handle", DateTimeOffset.UtcNow, "invite-1", "sam");

        var taken = ceremonies.Take(id, DateTimeOffset.UtcNow);

        Assert.NotNull(taken);
        Assert.True(PasskeyService.SignUpMatches(taken!.Value, "invite-1", "sam"));
    }

    [Theory]
    [InlineData("invite-2", "sam")]
    [InlineData("invite-1", "alex")]
    [InlineData(null, "sam")]
    public void ASignUpCeremonyCannotBeFinishedForAnotherInviteOrName(string? inviteId, string username)
    {
        var ceremony = new PasskeyCeremony("{}", "handle", DateTimeOffset.UtcNow.AddMinutes(5), "invite-1", "sam");
        Assert.False(PasskeyService.SignUpMatches(ceremony, inviteId, username));
    }

    [Fact]
    public void TheNameComparesTheWayJellyfinsUniquenessDoes()
    {
        var ceremony = new PasskeyCeremony("{}", "handle", DateTimeOffset.UtcNow.AddMinutes(5), "invite-1", "Sam");
        Assert.True(PasskeyService.SignUpMatches(ceremony, "invite-1", "sam"));
    }

    [Fact]
    public void AnAccountRegistrationIsNeverASignUp()
    {
        // The ceremony `register/begin` issues has no invite, and must not satisfy the invite path.
        var ceremony = new PasskeyCeremony("{}", "user-id", DateTimeOffset.UtcNow.AddMinutes(5));
        Assert.False(PasskeyService.SignUpMatches(ceremony, null, null));
    }

    [Fact]
    public void AnOlderRowsHandleIsItsAccountId()
        => Assert.Equal("user-id", PasskeyService.HandleFor(new PasskeyRow { UserId = "user-id" }));

    [Fact]
    public async Task ARecordedHandleSurvivesTheDatabaseAndWins()
    {
        var store = new PasskeyStore(_db);
        await store.SaveAsync(
            new PasskeyRow
            {
                CredentialId = "cred",
                UserId = "user-id",
                UserHandle = "handle",
                RelyingParty = "example.com",
                PublicKey = new byte[] { 1, 2, 3 },
                CreatedAt = DateTimeOffset.UtcNow,
            },
            CancellationToken.None).ConfigureAwait(true);

        var row = store.ByCredentialId("cred");

        Assert.NotNull(row);
        Assert.Equal("handle", row!.UserHandle);
        Assert.Equal("handle", PasskeyService.HandleFor(row));
    }

    public void Dispose()
    {
        _db.Dispose();
        try
        {
            Directory.Delete(_dir, recursive: true);
        }
        catch (IOException)
        {
            // SQLite can hold the file a moment past dispose on Windows; the temp dir is disposable.
        }

        GC.SuppressFinalize(this);
    }

    /// <summary>A data directory and nothing else, which is all <see cref="CoreDatabase"/> reads.</summary>
    private sealed class FixedDataDirectory : INodeRuntimeProvider
    {
        public FixedDataDirectory(string directory) => DataDirectory = directory;

        public string? DataDirectory { get; }

        public string? RuntimeJsonPath => Path.Combine(DataDirectory!, "runtime.json");

        public NodeRuntime? Current => null;

        public void ClearFirstRun()
        {
        }

        public void SetServerName(string name)
        {
        }
    }
}
