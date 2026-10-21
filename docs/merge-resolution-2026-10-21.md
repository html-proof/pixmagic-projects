# Error-state branch integration

The branch started before 643 commits on main. A normal merge exposed 73 conflicted paths.
The resolution retains main's AWS runtime, Cognito authentication, shared-dashboard sessions,
permission enforcement, current domain settings and completed service extractions.

The branch's error illustrations, recovery components, public-link recovery, countdowns,
request timeouts and boundary checks were adapted to those current interfaces. HTTP transport
and React data hooks were separated while preserving access signals, auth challenge envelopes,
and the rule that a late refusal from a closed shared session must not sign the account out.
The current login validation and invitation lifecycle remain intact. The existing shared health
grading exports were retained, with non-finite trend comparisons classified as information only.

No deployment, database migration, history rewrite or force push is part of this resolution.
