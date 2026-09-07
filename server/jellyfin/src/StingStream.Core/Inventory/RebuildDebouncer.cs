using System;

namespace StingStream.Core.Inventory;

/// <summary>
/// Decides when a burst of library changes has settled enough to be worth one rebuild.
/// </summary>
/// <remarks>
/// <para>
/// A library scan raises one <c>ItemAdded</c> per file, so "rebuild on every event" would walk the
/// whole library once per title. What is wanted instead is one rebuild *after* the scan, and this
/// is the two rules that produce it:
/// </para>
/// <list type="bullet">
///   <item><description>
///     <b>Quiet period.</b> Run once nothing has changed for <see cref="QuietPeriod"/>. During a
///     ten-minute scan the period keeps resetting and nothing runs; five seconds after the last
///     file lands, one rebuild does.
///   </description></item>
///   <item><description>
///     <b>Maximum delay.</b> Run anyway once <see cref="MaximumDelay"/> has passed since the first
///     change, however busy things still are. Without it a library that never goes quiet for five
///     seconds — a big import running alongside a scan, a watched folder someone is copying into —
///     would defer the rebuild forever, which is the failure mode a pure debounce always has and
///     the one nobody notices until a node has been silently out of date for an afternoon.
///   </description></item>
/// </list>
/// <para>
/// Separated from <see cref="InventoryWatcher"/> because it is the only part with a decision in it,
/// and because a rule about time is worth testing without waiting for any.
/// </para>
/// </remarks>
public sealed class RebuildDebouncer
{
    /// <summary>How long the library must be quiet before a rebuild runs.</summary>
    public static readonly TimeSpan DefaultQuietPeriod = TimeSpan.FromSeconds(5);

    /// <summary>How long a rebuild may be deferred by continuing changes.</summary>
    public static readonly TimeSpan DefaultMaximumDelay = TimeSpan.FromSeconds(60);

    private readonly object _lock = new();

    private DateTime _firstUtc;
    private DateTime _lastUtc;
    private bool _pending;

    /// <summary>How long the library must be quiet before a rebuild runs.</summary>
    public TimeSpan QuietPeriod { get; init; } = DefaultQuietPeriod;

    /// <summary>How long a rebuild may be deferred by changes that keep arriving.</summary>
    public TimeSpan MaximumDelay { get; init; } = DefaultMaximumDelay;

    /// <summary>True when a change is waiting for a rebuild.</summary>
    public bool Pending
    {
        get
        {
            lock (_lock)
            {
                return _pending;
            }
        }
    }

    /// <summary>Note that something in the library changed.</summary>
    /// <param name="nowUtc">Now.</param>
    public void Note(DateTime nowUtc)
    {
        lock (_lock)
        {
            if (!_pending)
            {
                _pending = true;
                _firstUtc = nowUtc;
            }

            _lastUtc = nowUtc;
        }
    }

    /// <summary>Whether a rebuild is due, without claiming it.</summary>
    /// <param name="nowUtc">Now.</param>
    /// <returns>True when <see cref="TakeIfDue"/> would succeed.</returns>
    public bool IsDue(DateTime nowUtc)
    {
        lock (_lock)
        {
            return IsDueLocked(nowUtc);
        }
    }

    /// <summary>
    /// Claim the pending rebuild when it is due.
    /// </summary>
    /// <param name="nowUtc">Now.</param>
    /// <returns>True when the caller should rebuild.</returns>
    /// <remarks>
    /// Claiming clears the pending flag, so a change that arrives *during* the rebuild sets it
    /// again and earns a second pass. That is the whole of "at most one rebuild in flight": there
    /// is one caller, it takes the flag before it starts, and anything that happens while it works
    /// is not lost.
    /// </remarks>
    public bool TakeIfDue(DateTime nowUtc)
    {
        lock (_lock)
        {
            if (!IsDueLocked(nowUtc))
            {
                return false;
            }

            _pending = false;
            return true;
        }
    }

    private bool IsDueLocked(DateTime nowUtc)
        => _pending
            && (nowUtc - _lastUtc >= QuietPeriod || nowUtc - _firstUtc >= MaximumDelay);
}
