using System;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Logging;
using StingStream.Core.Arr;
using StingStream.Core.Configuration;
using StingStream.Core.Data;

namespace StingStream.Core.Library;

/// <summary>
/// Brings the running node in line with the saved library settings, off the request that saved
/// them.
/// </summary>
/// <remarks>
/// <para>
/// A library's switch is one boolean in <c>core.db</c>. What follows from it (which managers
/// <c>config.toml</c> asks for, creating or withdrawing the media server's library, the rescan
/// that follows) takes seconds, and <c>PUT /Libraries/{id}</c> used to wait for all of it before
/// answering. Dan, 2026-09-22: the switch "should literally just toggle a boolean on/off, and
/// trigger anything else async after the toggle". So the controller saves the boolean, answers,
/// and asks this to do the rest.
/// </para>
/// <para>
/// <b>One pass at a time, and a request during a pass runs one more after it.</b> Two passes of
/// <see cref="LibraryLayoutService.EnsureAsync"/> side by side is how a switch used to flip itself
/// back: each read the settings when it started and saved what it learned when it finished, so a
/// pass that began before the second press saved the first press's value over it. That save now
/// merges (<see cref="SettingsStore.SaveLibraryBookkeepingAsync"/>), and this keeps the passes
/// from overlapping in the first place. Any number of presses during a pass collapse into the one
/// pass after it, which reads the settings as they are by then.
/// </para>
/// </remarks>
public sealed class LibraryApplyQueue
{
    private readonly SerialCoalescer _runner;

    public LibraryApplyQueue(
        SettingsStore settings,
        LibraryLayoutService layout,
        INodeRuntimeProvider runtime,
        ILogger<LibraryApplyQueue> logger)
    {
        _runner = new SerialCoalescer(
            async ct =>
            {
                // `mayStop` because this follows somebody at the Libraries screen. See
                // ArrEnablement: the background worker is the careful one on a first run.
                ArrEnablement.Reconcile(settings.Get(), runtime.DataDirectory, logger, mayStop: true);
                await layout.EnsureAsync(ct).ConfigureAwait(false);
            },
            logger);
    }

    /// <summary>Apply the saved settings soon. Returns at once.</summary>
    /// <returns>The pass that will pick this request up, for a caller that wants to wait.</returns>
    public Task Request() => _runner.Request();
}

/// <summary>
/// Runs one piece of work at a time, and folds every request made while it is running into a
/// single run after it.
/// </summary>
/// <remarks>
/// Public and free of the node's services so a test can drive it with a delegate.
/// </remarks>
public sealed class SerialCoalescer
{
    private readonly object _lock = new();
    private readonly Func<CancellationToken, Task> _work;
    private readonly ILogger _logger;
    private bool _running;
    private bool _pending;
    private Task _current = Task.CompletedTask;

    public SerialCoalescer(Func<CancellationToken, Task> work, ILogger logger)
    {
        _work = work ?? throw new ArgumentNullException(nameof(work));
        _logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    /// <summary>Ask for a run. Never waits for one.</summary>
    /// <returns>A task that completes once a run that began after this request has finished.</returns>
    public Task Request()
    {
        lock (_lock)
        {
            if (_running)
            {
                _pending = true;
                return _current;
            }

            _running = true;
            _current = Task.Run(LoopAsync);
            return _current;
        }
    }

    private async Task LoopAsync()
    {
        while (true)
        {
            lock (_lock)
            {
                _pending = false;
            }

            try
            {
                await _work(CancellationToken.None).ConfigureAwait(false);
            }
#pragma warning disable CA1031 // A background pass that throws must not take the next one with it.
            catch (Exception ex)
#pragma warning restore CA1031
            {
                _logger.LogWarning(ex, "Applying the library settings failed; the next change or restart tries again");
            }

            lock (_lock)
            {
                if (!_pending)
                {
                    _running = false;
                    return;
                }
            }
        }
    }
}
