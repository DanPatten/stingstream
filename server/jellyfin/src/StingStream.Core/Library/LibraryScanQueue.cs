using System;
using System.Linq;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace StingStream.Core.Library;

/// <summary>
/// Asks the media server for a whole-library scan, behind any scan already running rather than in
/// place of it.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why not <c>ILibraryManager.ValidateMediaLibrary</c>.</b> That is
/// <c>CancelIfRunningAndQueue</c>: it throws away the scan in progress and starts over. A person
/// adding three folders to a large library one after another restarted the same long scan three
/// times, and <see cref="LibraryLayoutService"/> used to limit itself to one scan per pass for
/// exactly that reason.
/// </para>
/// <para>
/// <c>ITaskManager.QueueScheduledTask</c> starts the scan when none is running and otherwise puts
/// it behind the one that is. When that run ends, the task manager runs each queued task type once,
/// however many times it was queued, so any number of requests during a scan become a single scan
/// after it. That follow-up is not optional: a scan that had already walked the library's folders
/// when a new one arrived never sees it.
/// </para>
/// <para>
/// Never waits. The task manager runs the scan on its own thread, so a request handler that asks
/// for one answers at once.
/// </para>
/// </remarks>
public sealed class LibraryScanQueue
{
    /// <summary>The key of the media server's "Scan Media Library" task (<c>RefreshMediaLibraryTask</c>).</summary>
    public const string ScanTaskKey = "RefreshLibrary";

    private readonly ITaskManager _tasks;
    private readonly ILogger<LibraryScanQueue> _logger;

    public LibraryScanQueue(ITaskManager tasks, ILogger<LibraryScanQueue> logger)
    {
        _tasks = tasks;
        _logger = logger;
    }

    /// <summary>Queue a scan of every library. Returns at once.</summary>
    /// <param name="reason">Why, for the log.</param>
    /// <returns><c>false</c> when the media server has no scan task to queue.</returns>
    public bool Request(string reason)
    {
        // Found by key rather than by type: the task lives in Emby.Server.Implementations, which
        // this assembly does not reference, and the key is what the media server's own scheduled
        // task settings are stored under, so it does not move.
        var worker = _tasks.ScheduledTasks.FirstOrDefault(
            t => string.Equals(t.ScheduledTask?.Key, ScanTaskKey, StringComparison.Ordinal));
        if (worker is null)
        {
            _logger.LogWarning("No library scan task to queue ({Reason})", reason);
            return false;
        }

        var running = worker.State != TaskState.Idle;
        _tasks.QueueScheduledTask(worker.ScheduledTask, new TaskOptions());
        if (running)
        {
            _logger.LogInformation("Library scan queued behind the one running: {Reason}", reason);
        }
        else
        {
            _logger.LogInformation("Library scan started: {Reason}", reason);
        }

        return true;
    }
}
