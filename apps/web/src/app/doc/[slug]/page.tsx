import { DocEditor } from "@/components/DocEditor";

interface DocPageProps {
  params: Promise<{ slug: string }>;
}

export default async function DocPage({ params }: DocPageProps) {
  // params is a Promise in the App Router (async by design, not a typing mistake)
  const { slug } = await params;
  return <DocEditor slug={slug} />;
}
