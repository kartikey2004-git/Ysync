import { DocEditor } from "@/components/DocEditor";

interface DocPageProps {
  params: Promise<{ slug: string }>;
}

export default async function DocPage({ params }: DocPageProps) {
  // App Router mein params ek Promise hota hai (async by design hai, sirf typing ki gadbad nahi)
  const { slug } = await params;
  return <DocEditor slug={slug} />;
}
