from chrona.infrastructure.i18n import error_message
from chrona.infrastructure.i18n import msg
from chrona.infrastructure.resources import resource
import hashlib
import json
import math
import time
from pathlib import Path

from chrona.rendering.jobs import atomic_json
from chrona.adapters.prompt_enhancement.client import MiniMaxContextIR
from chrona.adapters.prompt_enhancement.media import video_content, image_content
from chrona.adapters.prompt_enhancement.settings import EnhancementStore

POLICY = resource('harness/rendering/prompts/prompt-enhancement.txt')
VERSION = 'reference-prompt-enhancement@1'


def file_hash(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''): result.update(block)
    return result.hexdigest()


def instruction_for(*, shot, direction, system, duration, has_image, base_prompt):
    policy = POLICY.read_text().strip()
    metadata = f'Actual shot duration: {duration:.3f} seconds. Supplied media: <Video 1>' + (' and <Picture 1> (appearance/continuity only).' if has_image else ' only; no images are supplied.')
    fields = [('SCENE', shot.get('scene', ''), 450), ('CAMERA', shot.get('motion', ''), 450),
              ('TIME / LIGHT / WEATHER / PHYSICS', shot.get('lighting', ''), 450),
              ('CURRENT EDITS', '\n'.join(shot.get('changes', [])), 500),
              ('CONTINUITY', shot.get('continuity', ''), 250),
              ('USER APPEARANCE DIRECTION', direction, 1100), ('RENDER RULES', system, 900)]
    fields += [('VISIBLE SUBJECT', item, 600) for item in shot.get('subjects', [])[:4]]
    if not shot: fields.insert(0, ('COMPILED SCENE', base_prompt, 2800))
    text, warnings = policy + '\n\n' + metadata, []
    for role, source, maximum in fields:
        if not source: continue
        room = min(maximum, 7000 - len(text) - len(role) - 5)
        value = source[:max(0, room)].strip()
        if value: text += f'\n\n{role}:\n{value}'
        if value != source.strip(): warnings.append(f'{role}: shortened for the official 7000-character input limit')
    return text, warnings


class PromptEnhancement:
    def __init__(self, settings, journal):
        self.store, self.journal = EnhancementStore(settings), journal
        self.client = MiniMaxContextIR()

    def capabilities(self):
        value = self.store.snapshot()
        return {'available': True, 'configured': value.configured, 'defaultEnabled': value.enabled,
                'label': 'MiniMax H3-Context-IR', 'referenceVideo': True, 'maxReferenceSeconds': 15}

    def capture(self, enabled, *, plan=None, parameters=None, tail_frames=0):
        if not enabled: return {'enabled': False}
        value = self.store.snapshot()
        if not value.configured: raise ValueError(msg('backend.adapters.prompt_enhancement.service.prompt-enhancement-api-is-not-configured-configure-it-in'))
        if plan:
            if any((s['frames'] + tail_frames) / plan['outputFps'] > 15 for s in plan['segments']):
                raise ValueError(msg('backend.adapters.prompt_enhancement.service.prompt-enhancement-supports-at-most-15-seconds-per-reference'))
            ratio = parameters['width'] / parameters['height']
            if not 0.4 <= ratio <= 2.5: raise ValueError(msg('backend.adapters.prompt_enhancement.service.prompt-enhancement-requires-a-video-aspect-ratio-of-0'))
        return {'enabled': True, **value.identity(), 'version': VERSION, 'policySha256': file_hash(POLICY)}

    def current(self, captured):
        value = self.store.snapshot()
        if not value.configured: raise ValueError(msg('backend.adapters.prompt_enhancement.service.the-prompt-enhancement-api-key-was-removed-restore-it'))
        if any(captured.get(k) != v for k, v in value.identity().items()):
            raise ValueError(msg('backend.adapters.prompt_enhancement.service.the-enhancement-service-or-model-changed-restore-the-original'))
        if captured.get('version') != VERSION: raise ValueError(msg('backend.adapters.prompt_enhancement.service.the-prompt-enhancement-protocol-changed-submit-a-new-video'))
        if captured.get('policySha256') != file_hash(POLICY): raise ValueError(msg('backend.adapters.prompt_enhancement.service.the-prompt-enhancement-rules-changed-submit-a-new-video'))
        return value

    def enhance_segment(self, *, captured, folder, video, image, harness, direction, system, duration, report, cancelled):
        config = self.current(captured)
        instruction, warnings = instruction_for(shot=harness['shot'], direction=direction, system=system,
            duration=duration, has_image=image is not None, base_prompt=harness['prompt'])
        signature = hashlib.sha256(json.dumps({'instruction': instruction, 'source': harness['prompt'],
            'video': file_hash(video), 'image': file_hash(image) if image else None, 'config': captured}, sort_keys=True).encode()).hexdigest()
        path, prompt_path = folder / 'enhancement.json', folder / 'prompt-enhanced.txt'
        previous = json.loads(path.read_text()) if path.exists() else {}
        if previous.get('signature') == signature and previous.get('status') == 'succeeded' and prompt_path.exists() and file_hash(prompt_path) == previous.get('sha256'):
            report(msg('backend.adapters.prompt_enhancement.service.reusing-the-saved-enhanced-prompt'), event='prompt.enhancement.cached', promptPath=str(prompt_path), taskId=previous.get('taskId'))
            return prompt_path.read_text()
        state = previous if previous.get('signature') == signature else {'signature': signature, 'config': captured, 'createdAt': time.time()}
        (folder / 'enhancement-input.txt').write_text(instruction)
        report(msg('backend.adapters.prompt_enhancement.service.preparing-the-prompt-enhancement-reference-video'), event='prompt.enhancement.preparing',
               sourcePath=str(video), inputPath=str(folder / 'enhancement-input.txt'), warnings=warnings)
        content = [{'type': 'text', 'text': instruction}, video_content(video, folder / 'enhancement-reference.mp4')]
        if image: content.append(image_content(image))
        payload = {'model': config.model, 'content': content, 'duration': min(15, max(4, math.ceil(duration))), 'ratio': 'adaptive'}
        if len(json.dumps(payload).encode()) > 60 * 1024 * 1024: raise ValueError(msg('backend.adapters.prompt_enhancement.service.the-prompt-enhancement-request-exceeds-the-size-limit'))
        state.update(status='running', warnings=warnings, actualDuration=duration, requestedDuration=payload['duration'])
        atomic_json(path, state)
        def checkpoint(identifier):
            state['taskId'] = identifier; atomic_json(path, state)
        started = time.monotonic()
        try:
            result = self.client.enhance(config, payload, task_id=state.get('taskId'), checkpoint=checkpoint, report=report, cancelled=cancelled)
        except Exception as error:
            state.update(status='failed', error=error_message(error)); atomic_json(path, state)
            if getattr(error, 'terminal', False):
                state['previousTaskId'] = state.pop('taskId', None); atomic_json(path, state)
            report(msg('backend.adapters.prompt_enhancement.service.prompt-enhancement-failed-video-generation-has-not-started'), event='prompt.enhancement.failed', error=error_message(error), manifestPath=str(path))
            raise
        prompt_path.write_text(result['prompt'])
        state.update(status='succeeded', sha256=file_hash(prompt_path), taskId=result['taskId'], usage=result['usage'],
                     elapsedSeconds=time.monotonic() - started, error=None)
        atomic_json(path, state)
        report(msg('backend.adapters.prompt_enhancement.service.prompt-enhancement-complete'), event='prompt.enhancement.succeeded', taskId=result['taskId'], prompt=result['prompt'],
               promptPath=str(prompt_path), manifestPath=str(path), usage=result['usage'], elapsedSeconds=state['elapsedSeconds'])
        return result['prompt']

    def test(self, config):
        if not config.configured: raise ValueError(msg('backend.adapters.prompt_enhancement.service.enter-a-prompt-enhancement-api-key'))
        started = time.monotonic()
        result = self.client.enhance(config, {'model': config.model, 'duration': 4, 'ratio': '16:9',
            'content': [{'type': 'text', 'text': 'One continuous photoreal first-person shot of a quiet forest path at midday. Preserve the scene and a stationary camera. Describe believable bark, grass and daylight. No cuts, people, captions or music. Return a concise structured video prompt.'}]},
            checkpoint=lambda _: None, report=lambda *args, **kwargs: None)
        return {'model': config.model, 'taskId': result['taskId'], 'prompt': result['prompt'], 'latencyMs': round((time.monotonic() - started) * 1000)}
