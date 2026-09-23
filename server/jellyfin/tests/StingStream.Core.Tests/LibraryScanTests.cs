using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Events;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging.Abstractions;
using StingStream.Core.Library;
using Xunit;

namespace StingStream.Core.Tests;

/// <summary>
/// When a change to a library's folders is followed by a scan, and how that scan is asked for.
/// </summary>
/// <remarks>
/// <para>
/// Dan, 2026-09-22, on a v0.2.1 beta: a second folder added to Movies showed zero movies, and
/// "Scan library files" afterwards found nothing either. Adding a folder wrote it into the media
/// server's library and then queued no scan, because only a created library or a removed folder
/// did. A per-library scan cannot make up for that: it walks the physical folders the library
/// already knew about, and a folder becomes one of those only when the whole library is scanned.
/// </para>
/// <para>
/// The scan is queued rather than started over. The media server's own
/// <c>ValidateMediaLibrary</c> cancels a scan that is running and starts again, so a person adding
/// three folders one after another restarted a long scan three times.
/// </para>
/// </remarks>
public class LibraryScanTests
{
    private static string Rooted(params string[] parts)
        => Path.Combine(new[] { Path.GetPathRoot(Path.GetTempPath())! }.Concat(parts).ToArray());

    [Fact]
    public void AFolderAddedToAnExistingLibraryIsScanned()
    {
        Assert.True(LibraryLayoutPlan.NeedsScan(
            added: new[] { Rooted("second", "Movies") },
            removed: Array.Empty<string>(),
            retyped: false,
            unscanned: Array.Empty<string>()));
    }

    [Fact]
    public void AFolderRemovedFromALibraryIsScanned()
    {
        Assert.True(LibraryLayoutPlan.NeedsScan(
            added: Array.Empty<string>(),
            removed: new[] { Rooted("old", "Movies") },
            retyped: false,
            unscanned: Array.Empty<string>()));
    }

    [Fact]
    public void ALibraryThatDidNotChangeIsNotScanned()
    {
        // The every-start no-op. Reconciliation runs on every boot, and a scan per boot would be a
        // scan for nothing on every node there is.
        Assert.False(LibraryLayoutPlan.NeedsScan(
            added: Array.Empty<string>(),
            removed: Array.Empty<string>(),
            retyped: false,
            unscanned: Array.Empty<string>()));
    }

    [Fact]
    public void AFolderThatWasAddedButNeverScannedIsScannedOnTheNextPass()
    {
        // The repair for a node that took a folder before the fix: the folder is already in the
        // library, so there is nothing to add, and without this it would stay empty for good.
        Assert.True(LibraryLayoutPlan.NeedsScan(
            added: Array.Empty<string>(),
            removed: Array.Empty<string>(),
            retyped: false,
            unscanned: new[] { Rooted("second", "Movies") }));
    }

    [Fact]
    public void UnscannedIsTheLocationsWithNoFolderInTheLibraryYet()
    {
        var known = Rooted("data", "media", "Movies");
        var fresh = Rooted("second", "Movies");
        var unplugged = Rooted("usb", "Movies");
        var emptyTree = Rooted("data", "federated", "movies");

        var unscanned = LibraryLayoutPlan.Unscanned(
            new[] { known, fresh, unplugged, emptyTree },
            hasFolder: p => LibraryLayoutService.SamePath(p, known),
            hasContent: p => !LibraryLayoutService.SamePath(p, unplugged) && !LibraryLayoutService.SamePath(p, emptyTree));

        // A scan makes no item for a drive that is not plugged in, nor for an empty folder (the
        // federated tree before any peer has written to it, which is how this was found on node 1).
        // Counting either would ask for a scan on every pass.
        Assert.Equal(new[] { fresh }, unscanned);
    }

    [Fact]
    public void AScanIsQueuedThroughTheMediaServersOwnTask()
    {
        var tasks = new FakeTaskManager(TaskState.Idle);
        var queue = new LibraryScanQueue(tasks, NullLogger<LibraryScanQueue>.Instance);

        Assert.True(queue.Request("a folder was added"));

        Assert.Equal(new[] { LibraryScanQueue.ScanTaskKey }, tasks.Queued);
        Assert.Equal(0, tasks.Cancelled);
    }

    [Fact]
    public void AScanAlreadyRunningIsNotCancelled()
    {
        // Queued behind it instead. The task manager runs one of each queued task once the current
        // run ends, so several folders added during a long scan are one more scan, not several.
        var tasks = new FakeTaskManager(TaskState.Running);
        var queue = new LibraryScanQueue(tasks, NullLogger<LibraryScanQueue>.Instance);

        Assert.True(queue.Request("a folder was added"));
        Assert.True(queue.Request("another folder was added"));

        Assert.Equal(0, tasks.Cancelled);
        Assert.Equal(2, tasks.Queued.Count);
    }

    [Fact]
    public void ANodeWithNoScanTaskSaysSoRatherThanThrowing()
    {
        var tasks = new FakeTaskManager(TaskState.Idle, withScanTask: false);
        var queue = new LibraryScanQueue(tasks, NullLogger<LibraryScanQueue>.Instance);

        Assert.False(queue.Request("a folder was added"));
    }

    private sealed class FakeTask(string key) : IScheduledTask
    {
        public string Name => key;

        public string Key => key;

        public string Description => key;

        public string Category => "Library";

        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken) => Task.CompletedTask;

        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => Array.Empty<TaskTriggerInfo>();
    }

    private sealed class FakeWorker(IScheduledTask task, TaskState state) : IScheduledTaskWorker
    {
        public event EventHandler<GenericEventArgs<double>>? TaskProgress
        {
            add { }
            remove { }
        }

        public IScheduledTask ScheduledTask => task;

        public TaskResult LastExecutionResult => null!;

        public string Name => task.Name;

        public string Description => task.Description;

        public string Category => task.Category;

        public TaskState State => state;

        public double? CurrentProgress => null;

        public IReadOnlyList<TaskTriggerInfo> Triggers { get; set; } = Array.Empty<TaskTriggerInfo>();

        public string Id => task.Key;

        public void ReloadTriggerEvents()
        {
        }

        public void Dispose()
        {
        }
    }

    private sealed class FakeTaskManager : ITaskManager
    {
        public FakeTaskManager(TaskState state, bool withScanTask = true)
        {
            var workers = new List<IScheduledTaskWorker> { new FakeWorker(new FakeTask("CleanCache"), TaskState.Idle) };
            if (withScanTask)
            {
                workers.Add(new FakeWorker(new FakeTask(LibraryScanQueue.ScanTaskKey), state));
            }

            ScheduledTasks = workers;
        }

        public event EventHandler<GenericEventArgs<IScheduledTaskWorker>>? TaskExecuting
        {
            add { }
            remove { }
        }

        public event EventHandler<TaskCompletionEventArgs>? TaskCompleted
        {
            add { }
            remove { }
        }

        public List<string> Queued { get; } = new();

        public int Cancelled { get; private set; }

        public IReadOnlyList<IScheduledTaskWorker> ScheduledTasks { get; }

        public void CancelIfRunningAndQueue<T>(TaskOptions options)
            where T : IScheduledTask => Cancelled++;

        public void CancelIfRunningAndQueue<T>()
            where T : IScheduledTask => Cancelled++;

        public void CancelIfRunning<T>()
            where T : IScheduledTask => Cancelled++;

        public void QueueScheduledTask<T>(TaskOptions options)
            where T : IScheduledTask => throw new NotSupportedException();

        public void QueueScheduledTask<T>()
            where T : IScheduledTask => throw new NotSupportedException();

        public void QueueIfNotRunning<T>()
            where T : IScheduledTask => throw new NotSupportedException();

        public void QueueScheduledTask(IScheduledTask task, TaskOptions options) => Queued.Add(task.Key);

        public void AddTasks(IEnumerable<IScheduledTask> tasks) => throw new NotSupportedException();

        public void Cancel(IScheduledTaskWorker task) => Cancelled++;

        public Task Execute(IScheduledTaskWorker task, TaskOptions options) => throw new NotSupportedException();

        public void Execute<T>()
            where T : IScheduledTask => throw new NotSupportedException();

        public void Dispose()
        {
        }
    }
}
