namespace NzbWebDAV.Exceptions;

public class UnsupportedRarUnknownSizeException(string message) : NonRetryableDownloadException(message)
{
}
