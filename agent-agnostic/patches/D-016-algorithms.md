<<<<<<< FIND
  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

  session = app_server.start_session(workspace=workspace.path)
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("agent session startup error")

  max_turns = config.agent.max_turns
  turn_number = 1

  while true:
    prompt = build_turn_prompt(workflow_template, issue, attempt, turn_number, max_turns)
    if prompt failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = app_server.run_turn(
      session=session,
      prompt=prompt,
      issue=issue,
      on_message=(msg) -> send(orchestrator_channel, {codex_update, issue.id, msg})
    )
=======
  if run_hook("before_run", workspace.path) failed:
    fail_worker("before_run hook error")

<!-- delta: D-016 -->
  adapter = agent_registry.resolve(config.runner.kind)
  if adapter is null:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("unsupported_agent_kind")

  capabilities = adapter.capabilities()

  session = adapter.start_session(
    workspace_path=workspace.path,
    issue=issue,
    runner_config=config.runner,
    tools=(capabilities.client_tools ? tracker.agent_tool_specs() : []),
    execute_tool=(name, args) -> tracker.execute_agent_tool(name, args, {issue: issue}),
    environment=child_environment_without_tracker_secrets()
  )
  if session failed:
    run_hook_best_effort("after_run", workspace.path)
    fail_worker("agent session startup error")

  max_turns = config.agent.max_turns
  turn_number = 1

  while true:
    # A turn resends the full task prompt on turn 1, and on every turn when the adapter
    # cannot carry conversation state between turns (Section 7.1).
    send_full_prompt = (turn_number == 1) or (not capabilities.session_continuation)
    prompt = build_turn_prompt(
      workflow_template, issue, attempt, turn_number, max_turns,
      full_prompt=send_full_prompt
    )
    if prompt failed:
      adapter.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("prompt error")

    turn_result = adapter.run_turn(
      session=session,
      turn_input={
        turn_number: turn_number,
        kind: (turn_number == 1 ? initial : continuation),
        text: prompt,
        title: format("%issue.identifier: %issue.title")
      },
      on_event=(event) -> send(orchestrator_channel, {agent_update, issue.id, event})
    )
>>>>>>> REPLACE
<<<<<<< FIND
    if turn_result failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("agent turn error")

    refreshed_issue = tracker.fetch_issues_by_ids([issue.id])
    if refreshed_issue failed:
      app_server.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("issue state refresh error")
=======
    if turn_result.status is not completed:
      adapter.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker(format("agent turn %turn_result.status"))

    refreshed_issue = tracker.fetch_issues_by_ids([issue.id])
    if refreshed_issue failed:
      adapter.stop_session(session)
      run_hook_best_effort("after_run", workspace.path)
      fail_worker("issue state refresh error")
>>>>>>> REPLACE
<<<<<<< FIND
    turn_number = turn_number + 1

  app_server.stop_session(session)
=======
    turn_number = turn_number + 1

  adapter.stop_session(session)
>>>>>>> REPLACE
