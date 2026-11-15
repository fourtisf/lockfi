import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, Manrope, Sora } from 'next/font/google';
import { MarketProvider } from '@/components/providers/MarketProvider';
import { UiProvider } from '@/components/providers/UiProvider';
import { WalletProvider } from '@/components/providers/WalletProvider';
import { Footer } from '@/components/shell/Footer';
import { TabBar } from '@/components/shell/Nav';
import { StakeDrawer } from '@/components/shell/StakeDrawer';
import { StaleBanner } from '@/components/shell/StaleBanner';
import { TopBar } from '@/components/shell/TopBar';
import { Toast } from '@/components/ui/Toast';
import { initialSnapshot } from '@/lib/data/initial-snapshot';
import { BRAND, SITE_URL, X_HANDLE } from '@/lib/site';
import './globals.css';

// §19: Sora for display, Manrope for words, IBM Plex Mono for every number.
const display = Sora({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-sora',
  display: 'swap',
});

const body = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-manrope',
  display: 'swap',
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-plex-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: `${BRAND} — Liquidity layer for Robinhood Chain`,
  description:
    'Stake into Robinhood Chain pools and collect a share of their real swap fees. No lockups, no emissions.',
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: BRAND,
    title: `${BRAND} — Liquidity layer for Robinhood Chain`,
    description:
      'Stake into Robinhood Chain pools and collect a share of their real swap fees. No lockups, no emissions.',
    images: [{ url: '/og-card.png', width: 1200, height: 630, alt: BRAND }],
  },
  twitter: { card: 'summary_large_image', site: X_HANDLE, creator: X_HANDLE, images: ['/og-card.png'] },
};

export const viewport: Viewport = {
  themeColor: '#0B6E86',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Live mode: the snapshot comes with the page instead of after it.
  const initial = await initialSnapshot();
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <WalletProvider>
        <UiProvider>
          <MarketProvider initial={initial}>
            <a className="skip" href="#main">
              Skip to content
            </a>
            <TopBar />
            <main className="wrap" id="main">
              <StaleBanner />
              {children}
              <Footer />
            </main>
            <TabBar />
            <StakeDrawer />
            <Toast />
          </MarketProvider>
        </UiProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
