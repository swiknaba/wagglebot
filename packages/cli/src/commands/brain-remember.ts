import type { LocalMemoryProposal, LocalMemoryProposalInput, LocalMemorySaveResult } from "@wagglebot/local-brain";

type RememberBrain = {
  memory: {
    propose(input: LocalMemoryProposalInput): Promise<LocalMemoryProposal>;
    save(input: { projectRoot: string; proposal: LocalMemoryProposal }): Promise<LocalMemorySaveResult>;
  };
};

export async function runBrainRemember(input: {
  projectPath: string;
  section: LocalMemoryProposalInput["section"];
  title: string;
  summary: string;
  evidence: LocalMemoryProposalInput["evidence"];
  save: boolean;
  brain: RememberBrain;
  write: (line: string) => void;
}): Promise<number> {
  try {
    const proposal = await input.brain.memory.propose({
      projectRoot: input.projectPath,
      section: input.section,
      title: input.title,
      summary: input.summary,
      evidence: input.evidence,
    });
    input.write(`Action: ${proposal.action}`);
    for (const warning of proposal.warnings) input.write(`Warning: ${warning}`);
    input.write(proposal.patch);
    if (proposal.action === "no_change") return 0;
    if (proposal.action === "needs_resolution") return 1;
    if (!input.save) return 0;
    const result = await input.brain.memory.save({ projectRoot: input.projectPath, proposal });
    input.write(`Saved concept ${result.path}; new bundle hash ${result.newBundleHash}`);
    for (const warning of result.warnings) input.write(`Warning: ${warning}`);
    return 0;
  } catch (error) {
    input.write(`brain remember: ${error instanceof Error ? error.message : "memory operation failed"}`);
    return 1;
  }
}
