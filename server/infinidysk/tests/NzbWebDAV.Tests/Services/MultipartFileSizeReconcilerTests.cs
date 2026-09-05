using NzbWebDAV.Database.Models;
using NzbWebDAV.Models;
using NzbWebDAV.Services;
using NzbWebDAV.Utils;

namespace NzbWebDAV.Tests.Services;

public class MultipartFileSizeReconcilerTests
{
    [Fact]
    public void TryGetPublishedSize_UnencryptedResolved_SumsPackedRanges()
    {
        var meta = new DavMultipartFile.Meta
        {
            IsLazy = false,
            FileParts =
            [
                Part(40),
                Part(60),
            ],
        };

        Assert.Equal(100, MultipartFileSizeReconciler.TryGetPublishedSize(meta));
    }

    [Fact]
    public void TryGetPublishedSize_FiniteAesDecodedSize_PreferredOverPackedSum()
    {
        var meta = new DavMultipartFile.Meta
        {
            IsLazy = false,
            AesParams = new AesParams { Key = new byte[16], Iv = new byte[16], DecodedSize = 80 },
            FileParts = [Part(96)],
        };

        Assert.Equal(80, MultipartFileSizeReconciler.TryGetPublishedSize(meta));
    }

    [Fact]
    public void TryGetPublishedSize_AesSentinel_ReturnsNull()
    {
        var meta = new DavMultipartFile.Meta
        {
            IsLazy = false,
            AesParams = new AesParams { Key = new byte[16], Iv = new byte[16], DecodedSize = long.MaxValue },
            FileParts = [Part(96)],
        };

        Assert.Null(MultipartFileSizeReconciler.TryGetPublishedSize(meta));
    }

    [Fact]
    public void TryGetPublishedSize_StillLazy_ReturnsNull()
    {
        var meta = new DavMultipartFile.Meta
        {
            IsLazy = true,
            FileParts = [Part(40)],
            PendingParts =
            [
                new DavMultipartFile.PendingPart
                {
                    SegmentIds = ["p"],
                    SegmentIdByteRange = LongRange.FromStartAndSize(0, 10),
                    EstimatedDataSize = 10,
                }
            ],
        };

        Assert.Null(MultipartFileSizeReconciler.TryGetPublishedSize(meta));
    }

    private static DavMultipartFile.FilePart Part(long count) => new()
    {
        SegmentIds = ["seg"],
        SegmentIdByteRange = LongRange.FromStartAndSize(0, count),
        FilePartByteRange = LongRange.FromStartAndSize(0, count),
    };
}
