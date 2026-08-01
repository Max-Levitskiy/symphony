<<<<<<< FIND
- Ticket mutations (state transitions, comments, attachments, PR metadata) are typically handled by
  the coding agent through the selected adapter's provider-native tools.
- Tools execute in Symphony with the configured adapter credential; the child receives tool results,
  not a raw token.
=======
<!-- delta: D-012 -->
- Ticket mutations (state transitions, comments, attachments, PR metadata) are typically handled by
  the coding agent through the selected tracker adapter's provider-native tools.
- Tools execute in Symphony with the configured adapter credential; the child receives tool results,
  not a raw token.
- This path requires the selected agent adapter to declare `client_tools=true` (Section 10.3). When
  it does not, the tools are simply not advertised and the workflow policy layer owns tracker writes
  by other means. Set `runner.require_client_tools: true` to make that downgrade a dispatch
  preflight failure instead of a silent one.
>>>>>>> REPLACE
