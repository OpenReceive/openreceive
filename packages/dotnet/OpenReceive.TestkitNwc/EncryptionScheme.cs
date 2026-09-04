namespace OpenReceive.TestkitNwc;

/// <summary>NIP-47 encryption scheme names as they appear in the `encryption` tag.</summary>
public static class EncryptionScheme
{
    public const string Nip04 = "nip04";
    public const string Nip44V2 = "nip44_v2";

    public static bool IsKnown(string scheme) => scheme is Nip04 or Nip44V2;
}
