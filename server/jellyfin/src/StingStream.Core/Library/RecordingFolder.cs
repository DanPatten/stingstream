using System.IO;

namespace StingStream.Core.Library;

/// <summary>Where this node's own DVR recordings are written.</summary>
/// <remarks>
/// <para>
/// This is Recordings' folder on the Libraries screen. The library's pointer tree of peers'
/// recordings stays derived (<see cref="LibraryLayoutPlan"/>); what a reader chooses is where
/// recordings made <em>here</em> land, which is the media server's Live TV <c>RecordingPath</c>.
/// </para>
/// <para>
/// The fallback has to match <c>RecordingsManager.DefaultRecordingPath</c> exactly, or the screen
/// would show one folder while recordings went to another. <c>InventoryService.RecordingRoots</c>
/// relies on the same rule.
/// </para>
/// </remarks>
public static class RecordingFolder
{
    /// <summary>The folder recordings go to.</summary>
    /// <param name="configured">The Live TV <c>RecordingPath</c>, when one is set.</param>
    /// <param name="dataPath">The media server's data directory.</param>
    /// <returns>An absolute path, or empty when neither is known.</returns>
    public static string Resolve(string? configured, string? dataPath)
    {
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured;
        }

        return string.IsNullOrWhiteSpace(dataPath)
            ? string.Empty
            : Path.Combine(dataPath, "livetv", "recordings");
    }
}
