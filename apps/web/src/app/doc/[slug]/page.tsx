import { DocEditor } from "@/components/DocEditor";

interface DocPageProps {
  params: Promise<{ slug: string }>;
}

export default async function DocPage({ params }: DocPageProps) {
  const { slug } = await params;
  return <DocEditor slug={slug} />;
}
