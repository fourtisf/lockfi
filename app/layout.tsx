import type { Metadata, Viewport } from 'next';
import { Instrument_Sans, JetBrains_Mono } from 'next/font/google';
import { MarketProvider } from '@/components/providers/MarketProvider';
import { UiProvider } from '@/components/providers/UiProvider';
import { Footer } from '@/components/shell/Footer';
import { StakeDrawer } from '@/components/shell/StakeDrawer';
import { Sidebar, TopBar } from '@/components/shell/TopNav';
import { WalletModal } from '@/components/shell/WalletModal';
import { CreatedTokensNotice } from '@/components/router/CreatedTokensNotice';
import { Toast } from '@/components/ui/Toast';
import { BRAND, SITE_URL, X_HANDLE } from '@/lib/site';
import './globals.css';

// Two faces, each with one job: Instrument Sans for everything read — set
// tight and heavy it is also the display face — and JetBrains Mono for
// everything counted, so a number is a number wherever it appears.
const sans = Instrument_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

const TAGLINE = 'Liquidity layer for Robinhood Chain';
const DESCRIPTION =
  "Deposit into any token on Robinhood Chain and earn its pool's swap fees. No lockups, no emissions.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${BRAND} — ${TAGLINE}`, template: `%s — ${BRAND}` },
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: BRAND,
    title: `${BRAND} — ${TAGLINE}`,
    description: DESCRIPTION,
    images: [{ url: '/og-card.png', width: 1200, height: 630, alt: BRAND }],
  },
  twitter: { card: 'summary_large_image', site: X_HANDLE, images: ['/og-card.png'] },
};

export const viewport: Viewport = {
  themeColor: '#07080B',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <UiProvider>
          <MarketProvider>
            <a className="skip" href="#main">
              Skip to content
            </a>
            <div className="app">
              <Sidebar />
              <div className="app-col">
                <TopBar />
                <main className="wrap" id="main">
                  {children}
                  <Footer />
                </main>
              </div>
            </div>
            <StakeDrawer />
            <WalletModal />
            <CreatedTokensNotice />
            <Toast />
          </MarketProvider>
        </UiProvider>
      </body>
    </html>
  );
}
