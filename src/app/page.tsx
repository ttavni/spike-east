import SpikeApp from "@/components/SpikeApp";
import { getLeagueData } from "@/lib/leagueData";

export const dynamic = "force-dynamic";

export default async function Home() {
  const data = await getLeagueData();
  return <SpikeApp data={data} />;
}
