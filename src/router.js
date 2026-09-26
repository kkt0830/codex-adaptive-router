const patterns = {
  trivial: [
    /\b(typo|spelling|readme|documentation|docs?|copy|label|button text|rename text)\b/i,
    /(오타|문구|버튼\s*텍스트|문서|읽어보기|맞춤법)/
  ],
  readSynthesis: [
    /\b(read|summari[sz]e|review|explain|analy[sz]e|inspect)\b/i,
    /(읽|요약|분석|검토|살펴|설명)/
  ],
  source: [
    /\b(api|endpoint|feature|implement|integration|refactor|tests?|backend|frontend)\b/i,
    /(기능|구현|연동|리팩터|테스트|엔드포인트)/
  ],
  advanced: [
    /\b(architecture|architectural|concurren\w*|race condition|deadlock|intermittent|flaky|root cause|unknown cause|multiple subsystems|distributed|migration|compatibility|refresh token rotation)\b/i,
    /(아키텍처|동시성|교착|간헐|재현.*(불명|어렵)|원인.*(불명|찾)|여러\s*서브시스템|분산|호환성|토큰\s*로테이션)/
  ],
  risk: [
    /\b(auth|authentication|security|payment|database|schema|production|deploy|migration|compatibility|concurren\w*|race condition|deadlock)\b/i,
    /(인증|보안|결제|데이터베이스|스키마|운영|배포|마이그레이션|호환성|동시성|교착)/
  ],
  scope: [
    /\b(multiple files|many files|entire repo|across|several systems|subsystems)\b/i,
    /(여러\s*파일|전체\s*저장소|여러\s*(시스템|subsystems?)|서브시스템)/i
  ],
  uncertainty: [
    /\b(unknown|unclear|intermittent|flaky|investigate|diagnose|find the cause)\b/i,
    /(불명|불확실|간헐|조사|진단|원인.*찾)/
  ]
};

function matches(text, group) {
  return patterns[group].some(re => re.test(text));
}

export function analyze(task) {
  if (typeof task !== 'string' || !task.trim()) throw new Error('Task text is required.');
  const text = task.trim();
  const trivial = matches(text, 'trivial');
  const readSynthesis = trivial && matches(text, 'readSynthesis');
  const source = matches(text, 'source');
  const advanced = matches(text, 'advanced');
  const risk = matches(text, 'risk');
  const scope = matches(text, 'scope');
  const uncertainty = matches(text, 'uncertainty');
  const signals = [];
  if (trivial) signals.push('clear, narrow text or documentation change');
  if (readSynthesis) signals.push('requires reading and synthesizing a file');
  if (source) signals.push('source implementation or verification requested');
  if (risk) signals.push('sensitive subsystem or compatibility constraint');
  if (scope) signals.push('broad project context');
  if (uncertainty) signals.push('unclear cause or requirements');
  if (advanced) signals.push('architecture or difficult debugging signal');

  // Gates protect quality; a broad file count alone never selects advanced.
  let tier = 'standard';
  if (advanced && (uncertainty || risk || scope)) tier = 'advanced';
  else if (trivial && !readSynthesis && !source && !risk && !scope && !uncertainty && !advanced) tier = 'light';

  const dimensions = {
    complexity: advanced ? 4 : source ? (scope ? 3 : 2) : readSynthesis ? 1 : trivial ? 0 : 1,
    context: scope ? 3 : risk ? 2 : source || readSynthesis ? 1 : 0,
    reasoning: advanced ? 4 : uncertainty ? 3 : source ? 2 : readSynthesis ? 1 : 0,
    risk: risk ? (advanced ? 4 : 3) : source ? 2 : 0,
    ambiguity: uncertainty ? (advanced ? 4 : 3) : advanced ? 2 : 0
  };
  return { classification: tier, dimensions, signals: signals.length ? signals : ['small, explicit task'], reason: signals.join('; ') || 'Small, explicit task.' };
}

export function select(task, config, options = {}) {
  const analysis = analyze(task);
  const tiers = ['light', 'standard', 'advanced'];
  let tier = options.tier && options.tier !== 'auto' ? options.tier : analysis.classification;
  if (!tiers.includes(tier)) throw new Error(`Invalid tier: ${tier}`);
  if ((!options.tier || options.tier === 'auto') && analysis.dimensions.risk >= 3) {
    const minimum = config.routing?.highRiskMinimumTier || 'standard';
    if (!tiers.includes(minimum)) throw new Error(`Invalid highRiskMinimumTier: ${minimum}`);
    if (tiers.indexOf(tier) < tiers.indexOf(minimum)) tier = minimum;
  }
  const choice = config.models?.[tier];
  if (!choice?.model || !choice?.reasoning) throw new Error(`Missing model mapping for tier: ${tier}`);
  return {
    task, analysis, tier, model: options.model || choice.model,
    reasoning: options.reasoning || choice.reasoning,
    override: Boolean((options.tier && options.tier !== 'auto') || options.model || options.reasoning),
    escalationExpected: tier === 'advanced' ? 'already at highest tier' : analysis.dimensions.ambiguity >= 3 ? 'possible after validation' : 'not expected'
  };
}
