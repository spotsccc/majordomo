import { requireOwnerSession } from "@/lib/auth";
import { Chat } from "./chat";

export default async function Home() {
  await requireOwnerSession();
  return <Chat />;
}
