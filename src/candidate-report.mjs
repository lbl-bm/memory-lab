const cell = value => String(value ?? 'unknown').replace(/[\r\n]+/g, ' ').replaceAll('|', '\\|').replaceAll('`', '\\`').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const classifications = { 'continuous-growth': '连续数量增长', 'accumulating-survivors': '多批新对象持续存活', 'stable-new-survivors': '新对象稳定保留（也可能是合法缓存）' };

export function renderCandidateReport(report) {
  const lines = ['# 通用内存候选排查', '', `分析状态：${cell(report.status)}。泄漏结论：尚未判定。`, ''];
  if (report.error) return [...lines, cell(report.error.message), ''].join('\n');
  lines.push(`候选组 ${report.candidateGroupCount}；入选对象 ${report.selectedInstanceCount}；未选组 ${report.omittedGroupCount}；入选组内未选对象 ${report.omittedInstanceCount}。`, '',
    '组的顺序按候选信号排序，不是已确认泄漏概率。保留大小只对声明的字面图成立，多个对象的保留字节不能相加。', '',
    `源码位置提示覆盖 ${report.sourceMapping?.coverage?.instancesWithHints ?? 0}/${report.selectedInstanceCount} 个入选对象。提示来自路径节点的 V8 位置；不等于分配栈、引用写入行或修复行。`, '');
  if (report.completeness?.witnessPathCount !== undefined) lines.push(`已证最短路径 ${report.completeness.provenShortestPathCount} 条；另有 ${report.completeness.witnessPathCount} 条有效字面路径尚未证明最短；${report.completeness.pathUnavailableCount} 个对象没有可展示路径。未证最短的搜索仍标为 incomplete。`, '');
  if (report.graphSummary?.status === 'incomplete') lines.push(`保留大小未计算：${cell(report.graphSummary.reason)}；已完成的候选、路径与源码提示继续保留。`, '');
  for (const group of report.groups ?? []) {
    lines.push(`## ${cell(group.name)} · ${cell(classifications[group.classification] ?? group.classification)}`, '',
      `数量序列：${group.counts.join(' / ')}；基线后新身份序列：${group.baselineAbsentByPoint?.join(' / ') ?? 'unknown'}。`, '',
      `已选 ${group.selectedInstanceCount}/${group.eligibleInstanceCount} 个对象；最终复查身份状态：${cell(group.candidateIdentityFollowup?.status)}。`, '');
    for (const instance of group.instances.slice(0, 3)) {
      lines.push(`- 对象 ${instance.nodeId}：观察于 ${instance.observedBackCount} 个返回检查点；最终复查 ${cell(instance.followup)}；路径 ${cell(instance.path?.outcome)}。`);
      const edges = (instance.path?.path ?? instance.path?.witnessPath)?.edges;
      if (instance.path?.witnessPath) lines.push('  已找到有效字面路径，最短性未证；搜索仍不完整。');
      if (edges) lines.push(`  持有路径边：${edges.slice(-10).map(edge => cell(edge.nameOrIndex)).join(' → ')}${edges.length > 10 ? '（仅展示末十条，JSON 保留完整路径）' : ''}。`);
      const hints = instance.sourceHints?.hints ?? [];
      if (!hints.length) lines.push(`  源码未知：${cell(instance.sourceHints?.unknownReasons?.join(', '))}。`);
      for (const hint of hints.slice(0, 3)) lines.push(`  V8 位置线索：${cell(hint.generated.url ?? 'scriptId=' + hint.generated.scriptId)}:${hint.generated.line}:${hint.generated.column}，路径节点 ${cell(hint.nodeName)}。`);
    }
    if (group.instances.length > 3) lines.push(`其余 ${group.instances.length - 3} 个入选对象见同目录 candidates.json。`);
    lines.push('');
  }
  lines.push('## 下一步复查', '', '先确认该操作结束后哪些对象应释放，再检查报告中的持有者和源码线索。针对可疑调用补采注册、容器写入或分配证据，然后用同一操作验证真实修复。稳定缓存、未知源码和被预算排除的对象均不能据此判定为正常或泄漏。', '');
  return lines.join('\n');
}
