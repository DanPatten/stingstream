namespace NzbWebDAV.Exceptions;

public class CorruptRarException(string message) : NonRetryableDownloadException(message)
{
}
