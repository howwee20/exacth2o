import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SWRConfig } from 'swr'
import { RuleModalProvider } from "./lib/RuleModal";
import { ZoneModalProvider } from "./lib/ZoneModal";
import { PairingsModalProvider } from "./lib/PairingsModal";
import { GroupModalProvider } from "./lib/GroupModal";
import { MultiEditPairingsModalProvider } from "./lib/MultiEditPairingsModal";
import { CSVExportModalProvider } from "./lib/CSVExportModalContext";
import { GenericModalProvider } from "./lib/GenericModal";
import { AuthProvider } from "./AuthProvider";
import { PolynomialModalProvider } from "./lib/PolynomialModal";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Walker Labs: Soil Moisture System",
  description: "Brought to you by Ursa Science, Inc.",
};


function GlobalProviders({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <GenericModalProvider>
          <RuleModalProvider>
            <GroupModalProvider>
              <ZoneModalProvider>
                <PolynomialModalProvider>
                  <PairingsModalProvider>
                    <MultiEditPairingsModalProvider>
                        <CSVExportModalProvider>
                          {children}
                        </CSVExportModalProvider>
                      </MultiEditPairingsModalProvider>
                    </PairingsModalProvider>
                  </PolynomialModalProvider>
              </ZoneModalProvider>
            </GroupModalProvider>
          </RuleModalProvider>
        </GenericModalProvider>
      </AuthProvider>
  )
}


export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link
          rel="icon"
          href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>💧</text></svg>"
        />
        <title>Ursa Watering Schedule</title>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <SWRConfig
          value={{
            revalidateOnFocus: false,
            errorRetryCount: 3,
          }}
        >
          <GlobalProviders>
            {children}
          </GlobalProviders>
        </SWRConfig>
      </body>
    </html>
  );
}
