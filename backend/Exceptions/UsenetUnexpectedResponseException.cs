namespace NzbWebDAV.Exceptions;

/// <summary>
/// Thrown when an NNTP command receives a response that is neither success nor
/// a clean 430 article-not-found — for example the buffered goodbye line of a
/// connection the server closed for idling ("400 too much time between commands").
/// Retryable: the article may well exist and a fresh connection should be tried.
/// </summary>
public class UsenetUnexpectedResponseException(string segmentId, string? serverResponse)
    : RetryableDownloadException(BuildMessage(segmentId, serverResponse))
{
    public string SegmentId => segmentId;

    private static string BuildMessage(string segmentId, string? serverResponse)
    {
        return $"Unexpected NNTP response while fetching article {segmentId}: " +
               $"{serverResponse ?? "<no response>"}";
    }
}
