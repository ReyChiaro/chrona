"""MiniMax's documented asynchronous H3-Context-IR API, separate from video inference."""
from chrona.infrastructure.i18n import msg
import re
import time
from urllib.parse import quote

import httpx


class EnhancementError(ValueError):
    def __init__(self, message, *, terminal=False):
        super().__init__(message)
        self.terminal = terminal


class MiniMaxContextIR:
    def __init__(self, *, transport=None, sleep=time.sleep):
        self.transport, self.sleep = transport, sleep

    def enhance(self, config, payload, *, task_id=None, checkpoint, report, cancelled=lambda: False):
        deadline = time.monotonic() + config.timeout_seconds
        headers = {'Authorization': f'Bearer {config.api_key.get_secret_value()}', 'Content-Type': 'application/json'}
        # Redirects are intentionally not followed with the API credential.
        with httpx.Client(headers=headers, transport=self.transport, follow_redirects=False) as client:
            def call(method, path, **kwargs):
                if cancelled(): raise InterruptedError('SERVICE_STOPPING')
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise TimeoutError(msg('backend.adapters.prompt_enhancement.client.prompt-enhancement-timed-out-resume-the-task-to-query'))
                try:
                    response = client.request(method, config.base_url + path, timeout=min(60, remaining), **kwargs)
                except httpx.TransportError as error:
                    raise EnhancementError(msg('backend.adapters.prompt_enhancement.client.prompt-enhancement-connection-failed-check-the-api-url-and')) from error
                if not response.is_success:
                    # Never echo an upstream response body: it may contain credentials or inline media.
                    hints = {401: msg('backend.adapters.prompt_enhancement.client.the-key-is-invalid-or-the-account-lacks-permission'), 402: msg('backend.adapters.prompt_enhancement.client.insufficient-account-balance'), 403: msg('backend.adapters.prompt_enhancement.client.the-account-does-not-have-access-to-this-api'),
                             413: msg('backend.adapters.prompt_enhancement.client.reference-media-exceeds-the-api-size-limit'), 422: msg('backend.adapters.prompt_enhancement.client.the-prompt-or-media-failed-service-validation'), 429: msg('backend.adapters.prompt_enhancement.client.rate-limit-exceeded-try-again-later')}
                    raise EnhancementError(msg('backend.adapters.prompt_enhancement.client.prompt-enhancement-api-returned-http', p0=response.status_code) + hints.get(response.status_code, msg('backend.adapters.prompt_enhancement.client.check-the-endpoint-parameters-and-service-status')))
                try: return response.json()
                except ValueError as error: raise EnhancementError(msg('backend.adapters.prompt_enhancement.client.prompt-enhancement-api-returned-a-non-json-response')) from error

            if not task_id:
                report(msg('backend.adapters.prompt_enhancement.client.submitting-the-prompt-and-reference-media'), event='prompt.enhancement.submitting')
                response = call('POST', '/v2/h3_context_ir', json=payload)
                task_id = response.get('task_id') if isinstance(response, dict) else None
                if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}', task_id):
                    raise EnhancementError(msg('backend.adapters.prompt_enhancement.client.prompt-enhancement-api-did-not-return-a-valid-task'))
                checkpoint(task_id)
            previous, last_report = None, 0
            while True:
                result = call('GET', '/v2/query/video_generation/' + quote(task_id, safe=''))
                task = result.get('task') if isinstance(result, dict) else None
                if not isinstance(task, dict): raise EnhancementError(msg('backend.adapters.prompt_enhancement.client.the-enhancement-status-response-is-missing-its-task'))
                status = task.get('status')
                if status == 'succeeded':
                    prompt = (task.get('content') or {}).get('prompt')
                    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 50000:
                        raise EnhancementError(msg('backend.adapters.prompt_enhancement.client.the-enhancement-task-did-not-return-valid-content-prompt'))
                    return {'prompt': prompt.strip(), 'taskId': task_id, 'usage': task.get('usage', {}), 'status': status}
                if status in {'failed', 'cancelled'}:
                    raise EnhancementError(msg('backend.adapters.prompt_enhancement.client.prompt-enhancement-task-task-id', p0=msg('backend.adapters.prompt_enhancement.client.cancelled') if status == "cancelled" else msg('backend.adapters.prompt_enhancement.client.failed'), p1=task_id), terminal=True)
                if status not in {'queued', 'running'}: raise EnhancementError(msg('backend.adapters.prompt_enhancement.client.the-enhancement-task-returned-an-unknown-status'))
                now = time.monotonic()
                if status != previous or now - last_report >= 15:
                    report(msg('backend.adapters.prompt_enhancement.client.prompt-enhancement-queued') if status == 'queued' else msg('backend.adapters.prompt_enhancement.client.understanding-the-reference-video-and-enhancing-the-prompt'),
                           event='prompt.enhancement.progress', taskId=task_id, status=status)
                    previous, last_report = status, now
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise TimeoutError(msg('backend.adapters.prompt_enhancement.client.prompt-enhancement-timed-out-resume-the-task-to-query'))
                self.sleep(min(config.poll_seconds, remaining))
