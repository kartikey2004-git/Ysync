-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "latestSeq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Operation" (
    "id" BIGSERIAL NOT NULL,
    "docId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "opId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "originId" TEXT,
    "value" TEXT,
    "attrs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL,
    "docId" TEXT NOT NULL,
    "atSeq" INTEGER NOT NULL,
    "state" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Operation_docId_seq_idx" ON "Operation"("docId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Operation_docId_opId_key" ON "Operation"("docId", "opId");

-- CreateIndex
CREATE INDEX "Snapshot_docId_atSeq_idx" ON "Snapshot"("docId", "atSeq");
