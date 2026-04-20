export const metadata = {
  title: 'Options Scanner',
  description: 'Simple options activity viewer'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'Arial, sans-serif', background: '#f5f7fb' }}>{children}</body>
    </html>
  );
}
