import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'TaskIndex — задачи',
  description: 'Агентство, разработка и личное. Каждому делу своё место.',
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
