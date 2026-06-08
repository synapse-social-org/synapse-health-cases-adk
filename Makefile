# Health Cases ADK — evaluation helpers
#
# Mirrors the `adk-eval` targets from the Synapse monorepo so the golden
# brief eval set in this slice can be run/validated in isolation.
#
# Live runs require GEMINI_API_KEY or GOOGLE_API_KEY and the broader Synapse
# research stack (this repo is a read-only mirror — see README).

.PHONY: adk-eval adk-eval-validate architecture-png

# Render docs/architecture.png from docs/architecture.mmd (requires Node/npx).
architecture-png:
	@npx --yes @mermaid-js/mermaid-cli@11 -i docs/architecture.mmd -o docs/architecture.png -b white -w 2800 -H 1600

# Run the golden brief scorecard against the ADK Health Case agent.
adk-eval:
	@cd backend && python scripts/run_adk_eval.py

# Validate the golden eval set / .evalset.json without invoking the model.
adk-eval-validate:
	@cd backend && python scripts/run_adk_eval.py --validate-only
