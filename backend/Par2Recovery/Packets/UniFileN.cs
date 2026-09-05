using System.Text;

namespace NzbWebDAV.Par2Recovery.Packets
{
    /// <summary>
    /// Optional PAR 2.0 Unicode Filename packet ("PAR 2.0\0UniFileN").
    /// Body: 16-byte File ID + UTF-16LE filename (padded to a multiple of 4 bytes).
    /// </summary>
    public class UniFileN : Par2Packet
    {
        public const string PacketType = "PAR 2.0\0UniFileN";

        public byte[] FileID { get; protected set; } = null!;
        public string FileName { get; protected set; } = null!;

        public UniFileN(Par2PacketHeader header) : base(header)
        {
        }

        protected override void ParseBody(byte[] body)
        {
            // 16	MD5 Hash	The File ID of the file.
            FileID = new byte[16];
            Buffer.BlockCopy(body, 0, FileID, 0, 16);

            // ?*4	Unicode char array (UTF-16LE)	Name of the file. Not null-terminated.
            var nameBuffer = new byte[body.Length - 16];
            Buffer.BlockCopy(body, 16, nameBuffer, 0, nameBuffer.Length);

            FileName = Encoding.Unicode.GetString(nameBuffer).Normalize().TrimEnd('\0');
        }

        public override string ToString()
        {
            return FileName ?? "UniFileN";
        }
    }
}
