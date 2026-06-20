import "@openreceive/react/styles.css";
import "./globals.css";

export const metadata = {
  title: "Hello Fruit Next.js Demo",
  description: "OpenReceive Hello Fruit checkout demo for Next.js."
};

export default function RootLayout({
  children
}: {
  readonly children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
