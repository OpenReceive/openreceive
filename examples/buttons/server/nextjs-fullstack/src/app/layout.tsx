// Mantine's own stylesheet first, then ours — the same order every stack uses.
import "@mantine/core/styles.css";
import "../../../../shared/shop.css";

export const metadata = {
  title: "Buy a Button — OpenReceive on Next.js",
  description: "A shop that sells six virtual OR buttons over Lightning or a stablecoin swap.",
};

export default function RootLayout({ children }: { readonly children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
