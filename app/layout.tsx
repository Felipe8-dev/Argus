import './globals.css';
import 'mapbox-gl/dist/mapbox-gl.css';

export const metadata = {
  title: 'ARGUS',
  description: 'Civilian Resilience Intelligence Network',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
