using NzbWebDAV.Database.Models;

namespace NzbWebDAV.Services;

/// <summary>
/// Computes the logical WebDAV/DB file size for a multipart archive.
/// AES uses the finite decoded size; stored (non-AES) uses packed part ranges.
/// </summary>
public static class MultipartFileSizeReconciler
{
    /// <summary>
    /// Returns the publishable size when it can be determined safely; otherwise null.
    /// </summary>
    public static long? TryGetPublishedSize(DavMultipartFile.Meta meta)
    {
        if (meta.IsLazy || (meta.PendingParts?.Length ?? 0) > 0)
            return null;

        var parts = meta.FileParts ?? [];
        if (parts.Length == 0)
            return null;

        var packedSum = SumResolvedBytes(parts);
        var decoded = meta.AesParams?.DecodedSize;
        if (decoded is long d && d > 0 && d != long.MaxValue)
            return d;

        if (meta.AesParams is not null)
        {
            // Encrypted with unknown/sentinel decoded size — do not guess from ciphertext.
            return null;
        }

        return packedSum;
    }

    public static long SumResolvedBytes(IEnumerable<DavMultipartFile.FilePart> parts)
    {
        var sum = 0L;
        foreach (var p in parts)
            sum += p.FilePartByteRange.Count;
        return sum;
    }

    public static long SumResolvedBytes(DavMultipartFile.Meta meta) =>
        SumResolvedBytes(meta.FileParts ?? []);
}
