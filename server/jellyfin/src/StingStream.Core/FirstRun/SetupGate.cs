using System;

namespace StingStream.Core.FirstRun;

/// <summary>What a first-run setup request may do.</summary>
public enum SetupAccess
{
    /// <summary>Go ahead: setup is pending and the caller is on this machine.</summary>
    Allow,

    /// <summary>This node already has an account. Answer 409.</summary>
    NotPending,

    /// <summary>The caller is not on this machine. Answer 404, as if the route did not exist.</summary>
    NotLocal,
}

/// <summary>
/// The whole decision behind <c>POST /stingstream/api/v1/setup/admin</c>, as one pure function.
/// </summary>
/// <remarks>
/// <para>
/// Separated from the controller because the decision is the part worth testing and the controller
/// is the part that cannot be: <c>tests/StingStream.Core.Tests</c> has no HTTP harness, by design.
/// <see cref="Decide"/> is what <c>SetupGateTests</c> exercises.
/// </para>
/// <para>
/// <b>Not local wins over not pending.</b> A caller off this machine gets the same answer whatever
/// state the node is in — 404, indistinguishable from the endpoint not existing — so a stranger on
/// the LAN cannot use the difference between 404 and 409 to learn whether a node they can reach is
/// still unclaimed. Somebody on the machine gets the truthful 409 instead, because they are the
/// person who has to act on it.
/// </para>
/// </remarks>
public static class SetupGate
{
    /// <summary>Longest username this endpoint accepts.</summary>
    /// <remarks>
    /// The server underneath allows more — word characters, spaces, apostrophes, <c>@</c> and
    /// <c>+</c>, with no length limit. This is the deliberately narrower set the first-run screen
    /// offers, chosen so that a name accepted here is always one the rename underneath accepts too.
    /// </remarks>
    public const int MaxUsernameLength = 32;

    /// <summary>Shortest password this endpoint accepts.</summary>
    public const int MinPasswordLength = 8;

    /// <summary>Whether this request may create the first account.</summary>
    /// <param name="pending">Whether the node is still waiting for its first account.</param>
    /// <param name="isLoopback">Whether the caller is on this machine.</param>
    /// <returns>The decision.</returns>
    public static SetupAccess Decide(bool pending, bool isLoopback)
    {
        if (!isLoopback)
        {
            return SetupAccess.NotLocal;
        }

        return pending ? SetupAccess.Allow : SetupAccess.NotPending;
    }

    /// <summary>
    /// Why this username cannot be used, or <see langword="null"/> when it can.
    /// </summary>
    /// <param name="username">The name somebody typed.</param>
    /// <returns>One sentence for the user, or <see langword="null"/>.</returns>
    public static string? ValidateUsername(string? username)
    {
        if (string.IsNullOrWhiteSpace(username))
        {
            return "Choose a name for your account.";
        }

        if (username.Length > MaxUsernameLength)
        {
            return $"A name can be at most {MaxUsernameLength} characters.";
        }

        foreach (var c in username)
        {
            if (!char.IsLetterOrDigit(c) && c != '.' && c != '_' && c != '-')
            {
                return "A name can only use letters, digits, dots, underscores and dashes.";
            }
        }

        return null;
    }

    /// <summary>
    /// Why this password cannot be used, or <see langword="null"/> when it can.
    /// </summary>
    /// <param name="password">The password somebody typed.</param>
    /// <returns>One sentence for the user, or <see langword="null"/>.</returns>
    /// <remarks>
    /// Length only, and no upper bound: a rule that demands a digit and a capital produces
    /// <c>Password1</c>, and a passphrase somebody will remember is worth more than a shape.
    /// Confirming the password is the screen's job, not this endpoint's.
    /// </remarks>
    public static string? ValidatePassword(string? password)
    {
        if (string.IsNullOrEmpty(password) || password.Length < MinPasswordLength)
        {
            return $"A password needs at least {MinPasswordLength} characters.";
        }

        return null;
    }

    /// <summary>The first thing wrong with these credentials, or <see langword="null"/>.</summary>
    /// <param name="username">The name somebody typed.</param>
    /// <param name="password">The password somebody typed.</param>
    /// <returns>One sentence for the user, or <see langword="null"/>.</returns>
    public static string? Validate(string? username, string? password)
        => ValidateUsername(username) ?? ValidatePassword(password);
}
