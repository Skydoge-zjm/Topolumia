# 权限边界

业务依据：[科研变更](../../product/business/research-changes.md)、[Agent 协作](../../product/business/agent-collaboration.md)。权限由服务端当前身份决定，UI 禁用和 MCP 工具目录过滤是辅助体验。

## 入口与领域动作

[HTTP authorization](../../../src/http/authorization.ts) 解析用户、项目和会话，检查访问边界；[CollaborationStore](../../../src/services/platform/collaboration-store.ts) 管成员、角色、覆盖权限和凭据。领域服务对具体动作再次校验，不能因为路由允许访问项目就默认可以提交所有变化。

MCP 的访问控制、每次调用授权与审计，不能代替 HTTP 和领域服务检查。即使绕过 MCP 直接调用 CLI/HTTP，也必须获得相同结果。

## 科研审批

[reviewPermission](../../../src/domain/research/review-policy.ts) 统一决定 accept 需要 research.applyChange，reject/defer 需要 research.review。涉及删除的接受还需撤销/替代权限。Agent 凭据不得自行审批。

候选读取范围、读取回执、正式对象版本、资产归属在执行时校验。幂等性防止重复提交，不能用来跳过授权。

节点组的 [领域权限](../modules/node-groups/interfaces-and-changes.md#授权历程与刷新) 复用科研权限：查看、直接修改、候选提出与审批分别授权；删除组及接受含删除组候选还需 research.withdrawOrSupersede。类型化 node/group 引用、成员与父组均校验当前项目，Agent 不能借人工组接口绕过审批。

## 原生执行审批

[approval-policy.ts](../../../src/services/agents/approval-policy.ts) 重新判断风险，不信任客户端或原生事件自报级别。

只有路径明确、解析现有祖先真实路径后仍在项目内的单次文件变更属于普通审批。相对路径依据请求 cwd；符号链接越界仍按项目外处理。

命令、网络、权限扩展、未知请求、外部路径，以及会话级或持久授权，需要 agent.approveHighRiskTool。持久拒绝也会修改策略，因此同样受限；普通拒绝和停止仍可用。

网关在调用 driver 前检查当前权限；前端复用 [共享选项策略](../../../src/domain/agents/agent-approval.ts)，显示禁用原因，不能仅依赖创建会话时的旧权限。

## 持续连接

SSE 发送前及心跳检查当前身份和项目权限，并订阅权限/成员/登录变化。撤权后发送 access.revoked 并关闭；缓存的页面或流连接不能延长访问权。

图片、科研资产和条件缓存响应在 304 前鉴权。关闭 Agent 运行实例时撤销其凭据。

验证：[approval-authority.test.ts](../../../tests/agents/sessions/approval-authority.test.ts)、[collaboration.test.ts](../../../tests/platform/collaboration.test.ts)、[reliability.test.ts](../../../tests/agents/sessions/reliability.test.ts)。
