namespace NzbWebDAV.Clients.Usenet;

/// <summary>
/// Exposes in-flight connection counts so replaced clients can drain before dispose.
/// </summary>
public interface INntpConnectionStats
{
    /// <summary>
    /// Borrowed connections plus pending provider selections still holding capacity.
    /// </summary>
    int InFlightConnections { get; }
}
