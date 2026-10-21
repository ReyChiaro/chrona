from chrona.infrastructure.i18n import error_message
from chrona.infrastructure.i18n import msg
import copy
import threading
import time
import uuid
from collections import OrderedDict

from chrona.authoring.edit_agent import propose_edit
from chrona.authoring.agents.scene import run_scene_agent
from chrona.authoring.agents.settings import AgentConfig, AgentConfigStore
from chrona.authoring.agents.access import AgentAccess


class SceneAgentManager:
    def __init__(self, settings, journal):
        initial = AgentConfig(enabled=settings.agent_enabled, baseUrl=settings.agent_base_url, model=settings.agent_model,
                              apiKey=settings.agent_api_key, timeoutSeconds=settings.agent_timeout_seconds, maxRounds=settings.agent_max_rounds)
        path = settings.agent_settings_path or settings.data_dir / 'agent' / 'settings.json'
        self.store = AgentConfigStore(path, initial)
        self.access = AgentAccess(settings.data_dir / 'agent' / 'access.token', settings.agent_access_token.get_secret_value(), settings.agent_browser_origin or settings.agent_world_url)
        self.world_url, self.journal = settings.agent_world_url, journal
        self.runs, self.lock = OrderedDict(), threading.RLock()
        self.slots = threading.BoundedSemaphore(2)

    def status(self, identifier):
        with self.lock:
            if identifier not in self.runs: raise KeyError(identifier)
            return copy.deepcopy({k: v for k, v in self.runs[identifier].items() if k != 'result'})

    def run(self, data, *, authorized=False):
        identifier = str(uuid.UUID(data['requestId']))
        if not isinstance(data.get('prompt'), str) or not 0 < len(data['prompt'].strip()) <= 12000:
            raise ValueError(msg('backend.authoring.agents.manager.enter-a-valid-instruction'))
        if not self.slots.acquire(blocking=False): raise ValueError(msg('backend.authoring.agents.manager.the-code-agent-is-busy-try-again-shortly'))
        try:
            with self.lock:
                old = self.runs.get(identifier)
                if old and old['status'] == 'running': raise ValueError(msg('backend.authoring.agents.manager.this-edit-request-is-already-running'))
                if old and old['mode'] == 'api' and not authorized: raise PermissionError(msg('backend.authoring.agents.manager.unlock-the-code-agent-first'))
                if old and old.get('result'): return copy.deepcopy(old['result'])
                config = self.store.snapshot()
                if config.mode == 'api' and not authorized: raise PermissionError(msg('backend.authoring.agents.manager.unlock-the-code-agent-first'))
                self.runs[identifier] = {'requestId': identifier, 'mode': config.mode, 'model': config.model if config.mode == 'api' else '',
                                         'status': 'running', 'phase': msg('backend.authoring.agents.manager.preparing-the-scene-edit'), 'startedAt': time.time(), 'trace': []}
                while len(self.runs) > 100:
                    finished = next((key for key, value in self.runs.items() if value['status'] != 'running'), None)
                    if finished is None: break
                    del self.runs[finished]

            def progress(**value):
                with self.lock: self.runs[identifier].update(value)
                self.journal.emit('agent.progress', value['phase'], requestId=identifier, mode=config.mode,
                                  model=config.model if config.mode == 'api' else '', trace=value.get('trace', [])[-1:])
            try:
                result = run_scene_agent(data, config, self.world_url, progress=progress, audit_dir=self.journal.root / 'agent' / 'runs' / identifier) if config.mode == 'api' else {**propose_edit(data), 'mode': 'offline-demo'}
                progress(phase=msg('backend.authoring.agents.manager.model-planning-complete-waiting-for-world-validation'), trace=result['trace'])
                with self.lock: self.runs[identifier].update(status='succeeded', finishedAt=time.time(), result=result)
                return result
            except Exception as error:
                message = error_message(error) if isinstance(error, ValueError) else msg('backend.authoring.agents.manager.the-code-agent-failed-check-the-service-configuration')
                with self.lock: self.runs[identifier].update(status='failed', phase=msg('backend.authoring.agents.manager.edit-not-applied'), error=message, finishedAt=time.time())
                self.journal.emit('agent.failed', msg('backend.authoring.agents.manager.code-agent-request-failed-no-edit-was-applied'), level='error', requestId=identifier, error=message)
                raise ValueError(message) from error
        finally:
            self.slots.release()
