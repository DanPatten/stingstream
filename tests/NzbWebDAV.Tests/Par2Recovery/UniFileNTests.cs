using System.Text;
using NzbWebDAV.Par2Recovery.Packets;

namespace NzbWebDAV.Tests.Par2Recovery;

public class UniFileNTests
{
    // UTF-16LE code units for "한국어.mkv" per PAR2 Unicode Filename packet:
    // 한 U+D55C, 국 U+AD6D, 어 U+C5B4, . U+002E, m U+006D, k U+006B, v U+0076
    private static readonly byte[] KoreanUtf16Le =
    [
        0x5C, 0xD5, 0x6D, 0xAD, 0xB4, 0xC5, 0x2E, 0x00,
        0x6D, 0x00, 0x6B, 0x00, 0x76, 0x00,
    ];

    // UTF-16LE for "日本語.mkv":
    // 日 U+65E5, 本 U+672C, 語 U+8A9E, . U+002E, m U+006D, k U+006B, v U+0076
    private static readonly byte[] JapaneseUtf16Le =
    [
        0xE5, 0x65, 0x2C, 0x67, 0x9E, 0x8A, 0x2E, 0x00,
        0x6D, 0x00, 0x6B, 0x00, 0x76, 0x00,
    ];

    [Fact]
    public void PacketType_IsExactlySixteenBytes()
    {
        Assert.Equal(16, Encoding.ASCII.GetByteCount(UniFileN.PacketType));
        Assert.Equal("PAR 2.0\0UniFileN", UniFileN.PacketType);
    }

    [Fact]
    public void ParseBody_DecodesKoreanUtf16LeName()
    {
        // Hardcoded fixture bytes must be UTF-16LE per PAR2 2.0 UniFileN.
        Assert.True(
            KoreanUtf16Le.AsSpan().SequenceEqual(Encoding.Unicode.GetBytes("한국어.mkv")),
            "Fixture must match UTF-16LE encoding of the Korean filename");

        var fileId = Enumerable.Range(1, 16).Select(i => (byte)i).ToArray();
        var uni = Parse(BuildBody(fileId, KoreanUtf16Le));

        Assert.Equal(fileId, uni.FileID);
        Assert.Equal("한국어.mkv", uni.FileName);
    }

    [Fact]
    public void ParseBody_DecodesJapaneseUtf16LeName()
    {
        Assert.True(
            JapaneseUtf16Le.AsSpan().SequenceEqual(Encoding.Unicode.GetBytes("日本語.mkv")),
            "Fixture must match UTF-16LE encoding of the Japanese filename");

        var fileId = Enumerable.Repeat((byte)0xAB, 16).ToArray();
        var uni = Parse(BuildBody(fileId, JapaneseUtf16Le));

        Assert.Equal(fileId, uni.FileID);
        Assert.Equal("日本語.mkv", uni.FileName);
    }

    [Fact]
    public void ParseBody_TrimsNullPadding()
    {
        // Name padded with UTF-16LE nulls to 4-byte alignment (PAR2 packet body rule).
        var nameBytes = Encoding.Unicode.GetBytes("가.mkv");
        var padded = new byte[((nameBytes.Length + 3) / 4) * 4];
        nameBytes.CopyTo(padded, 0);

        var uni = Parse(BuildBody(new byte[16], padded));
        Assert.Equal("가.mkv", uni.FileName);
    }

    private static TestUniFileN Parse(byte[] body)
    {
        var header = new Par2PacketHeader
        {
            Magic = "PAR2\0PKT"u8.ToArray(),
            PacketLength = (ulong)(64 + body.Length),
            PacketHash = new byte[16],
            RecoverySetID = new byte[16],
            PacketType = Encoding.ASCII.GetBytes(UniFileN.PacketType),
        };
        var packet = new TestUniFileN(header);
        packet.Parse(body);
        return packet;
    }

    private static byte[] BuildBody(byte[] fileId, byte[] utf16LeName)
    {
        var paddedLen = ((utf16LeName.Length + 3) / 4) * 4;
        var body = new byte[16 + paddedLen];
        fileId.CopyTo(body, 0);
        utf16LeName.CopyTo(body, 16);
        return body;
    }

    private sealed class TestUniFileN(Par2PacketHeader header) : UniFileN(header)
    {
        public void Parse(byte[] body) => ParseBody(body);
    }
}
