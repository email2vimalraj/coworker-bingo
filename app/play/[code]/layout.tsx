import { PlayerProvider } from "@/components/PlayerProvider";

export default function PlayLayout({ children }: { children: React.ReactNode }) {
  return <PlayerProvider>{children}</PlayerProvider>;
}
