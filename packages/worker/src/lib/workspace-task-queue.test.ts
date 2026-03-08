import { strict as assert } from 'assert';
import {
  createWorkspaceTaskQueueMessage,
  parseWorkspaceTaskQueueMessage,
} from './workspace-task-queue.js';

export async function runWorkspaceTaskQueueTests(): Promise<void> {
  {
    const message = createWorkspaceTaskQueueMessage('ws_abc12345', 'task_abcd1234');
    assert.equal(message.type, 'workspace_task_created');
    assert.equal(message.workspaceId, 'ws_abc12345');
    assert.equal(message.taskId, 'task_abcd1234');
  }

  {
    const parsed = parseWorkspaceTaskQueueMessage({
      type: 'workspace_task_created',
      workspaceId: 'ws_abc12345',
      taskId: 'task_abcd1234',
      queuedAt: '2026-03-08T00:00:00.000Z',
    });
    assert.equal(parsed.taskId, 'task_abcd1234');
  }

  {
    assert.throws(() =>
      parseWorkspaceTaskQueueMessage({
        type: 'workspace_task_created',
        workspaceId: 'ws-invalid',
        taskId: 'task_abcd1234',
        queuedAt: '2026-03-08T00:00:00.000Z',
      })
    );
  }
}
