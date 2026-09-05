using NzbWebDAV.Models;
using SharpCompress.Common.Rar.Headers;
using SharpCompress.Crypto;

namespace NzbWebDAV.Extensions;

public static class RarHeaderExtensions
{
    public static AesParams? GetAesParams(this IRarFileHeader header, string? password)
    {
        if (password is null || header.CryptoInfo is null) return null;

        var derived = RarKeyDerivation.DeriveKey(header.CryptoInfo, password);
        return new AesParams
        {
            Key = derived.Key,
            Iv = derived.Iv,
            // Never persist SharpCompress's unknown-size unpack sentinel as a real length.
            DecodedSize = header.IsUncompressedSizeUnknown ? 0 : header.UncompressedSize,
        };
    }
}
