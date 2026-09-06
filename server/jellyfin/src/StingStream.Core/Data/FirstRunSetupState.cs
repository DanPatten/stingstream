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
    public static Task SetAsync(SettingsStore settings, bool pending, CancellationToken cancellationToken = default)
        => settings.PutDocumentAsync(StorageKey, new FirstRunSetupState { Pending = pending }, cancellationToken);
}
