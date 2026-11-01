#!/usr/bin/env bash
# SR-07: every eval case is judged by (a) a format script over the final text
# and (b) a rule_based `output_contains` list that repeats `expect.must_contain`.
# No case runs a tool, inspects a trajectory, or asserts an exit code, so the
# suite cannot fail when the *code* stops enforcing a rule: it only scores the
# model echoing three lines. This PoC shows the judge accepting a correct-looking
# answer, and a format-legal answer that contradicts the Skill's own rule
# ("verify is a blocker, not a positive reason").
set -u
REPO=/Users/albaincompleta/DSH_CU
cd "$REPO" || exit 1
echo "== judge inventory across evals/cases =="
grep -h "type:" evals/cases/*.yaml | sort | uniq -c
echo "cases: $(ls evals/cases/*.yaml | wc -l | tr -d ' '); behavior/tool judges: $(grep -c 'tool_call\|trajectory\|exit_code' evals/cases/*.yaml | awk -F: '{s+=$2} END{print s+0}')"
echo
echo "== judge 1: a passing three-line answer (no execution happens anywhere) =="
EVAL_FINAL_MESSAGE=$'DECISION: ALLOW\nTOOL: browser_extract\nREASON: read-only' \
  .venv/bin/python evals/scripts/check_contract.py; echo "exit=$?"
echo
echo "== judge 1 accepts ALLOW+verify, which SKILL.md forbids =="
EVAL_FINAL_MESSAGE=$'DECISION: ALLOW\nTOOL: d1_browser_subgoal\nREASON: verify' \
  .venv/bin/python evals/scripts/check_contract.py; echo "exit=$?"
echo
echo "== judge 1 rejects a correct refusal phrased with one extra line of context =="
EVAL_FINAL_MESSAGE=$'DECISION: REFUSE\nTOOL: NONE\nREASON: approval\n(note: skipped approval)' \
  .venv/bin/python evals/scripts/check_contract.py; echo "exit=$?"
