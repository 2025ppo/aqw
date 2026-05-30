// ========== RBAC 权限控制系统 ==========
// 基于专家角色的权限模型

use serde::{Deserialize, Serialize};

// ---- 数据结构 ----

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum Permission {
    ReadFiles,
    WriteFiles,
    DeleteFiles,
    ExecuteCode,
    CallExternalApi,
    AccessMemory,
    ModifyMemory,
    AccessTokenData,
    SupervisorOverride,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Role {
    Supervisor,    // 主管：全部权限
    LeadEngineer,  // 主工程师：读写文件、执行代码、访问记忆
    Engineer,      // 工程师：读写文件、访问记忆
    Reviewer,      // 审查员：读文件、访问记忆
    Researcher,    // 调研员：读文件、访问记忆、调用外部API
    Designer,      // 设计师：读文件、写设计相关文件
    Assistant,     // 助手：访问记忆、读文件
}

impl Role {
    /// 获取角色对应的权限列表
    pub fn permissions(&self) -> Vec<Permission> {
        match self {
            Role::Supervisor => vec![
                Permission::ReadFiles,
                Permission::WriteFiles,
                Permission::DeleteFiles,
                Permission::ExecuteCode,
                Permission::CallExternalApi,
                Permission::AccessMemory,
                Permission::ModifyMemory,
                Permission::AccessTokenData,
                Permission::SupervisorOverride,
            ],
            Role::LeadEngineer => vec![
                Permission::ReadFiles,
                Permission::WriteFiles,
                Permission::ExecuteCode,
                Permission::AccessMemory,
                Permission::ModifyMemory,
                Permission::CallExternalApi,
            ],
            Role::Engineer => vec![
                Permission::ReadFiles,
                Permission::WriteFiles,
                Permission::AccessMemory,
            ],
            Role::Reviewer => vec![
                Permission::ReadFiles,
                Permission::AccessMemory,
            ],
            Role::Researcher => vec![
                Permission::ReadFiles,
                Permission::AccessMemory,
                Permission::CallExternalApi,
            ],
            Role::Designer => vec![
                Permission::ReadFiles,
                Permission::WriteFiles,
                Permission::AccessMemory,
            ],
            Role::Assistant => vec![
                Permission::ReadFiles,
                Permission::AccessMemory,
            ],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessDecision {
    pub allowed: bool,
    pub reason: Option<String>,
    pub required_permissions: Vec<Permission>,
}

// ---- 专家角色映射 ----

/// 根据专家 ID 获取默认角色
pub fn get_default_role(expert_id: &str) -> Role {
    match expert_id {
        "jiang-xingtu" => Role::Supervisor,
        "jiang-xinghe" => Role::LeadEngineer,
        "jiang-qinglan" => Role::Engineer,
        "jiang-yumo" => Role::Engineer,
        "jiang-subai" => Role::Engineer,
        "jiang-ruoxi" => Role::Researcher,
        "jiang-mingxuan" => Role::Reviewer,
        "jiang-zihan" => Role::Designer,
        "jiang-yanran" => Role::Assistant,
        _ => Role::Engineer,
    }
}

// ---- 权限检查 ----

/// 检查专家是否有指定权限
pub fn check_permission(expert_id: &str, permission: Permission) -> AccessDecision {
    let role = get_default_role(expert_id);
    let permissions = role.permissions();

    if permissions.contains(&permission) {
        AccessDecision {
            allowed: true,
            reason: None,
            required_permissions: vec![permission],
        }
    } else {
        AccessDecision {
            allowed: false,
            reason: Some(format!(
                "专家 {} 的角色 {:?} 没有 {:?} 权限",
                expert_id, role, permission
            )),
            required_permissions: vec![permission],
        }
    }
}

/// 检查专家是否可以访问指定路径
pub fn check_path_access(expert_id: &str, path: &str) -> AccessDecision {
    // 敏感路径列表
    let sensitive_paths = [
        ".env", ".ssh", "id_rsa", "id_dsa", ".p12", ".pem",
        "credentials", "secret", "password", "token",
        ".git/config", ".git/credentials",
    ];

    let lower_path = path.to_lowercase();
    for sensitive in &sensitive_paths {
        if lower_path.contains(sensitive) {
            // 只有主管和主工程师可以访问敏感路径
            let role = get_default_role(expert_id);
            match role {
                Role::Supervisor | Role::LeadEngineer => {
                    return AccessDecision {
                        allowed: true,
                        reason: Some(format!("敏感路径访问已授权（{:?}角色）", role)),
                        required_permissions: vec![Permission::ReadFiles],
                    };
                }
                _ => {
                    return AccessDecision {
                        allowed: false,
                        reason: Some(format!(
                            "专家 {} 无权访问敏感路径 {}",
                            expert_id, path
                        )),
                        required_permissions: vec![Permission::ReadFiles],
                    };
                }
            }
        }
    }

    AccessDecision {
        allowed: true,
        reason: None,
        required_permissions: vec![Permission::ReadFiles],
    }
}

/// 批量检查权限
#[allow(dead_code)]
pub fn check_permissions(expert_id: &str, permissions: &[Permission]) -> AccessDecision {
    let role = get_default_role(expert_id);
    let role_perms = role.permissions();

    let missing: Vec<Permission> = permissions
        .iter()
        .filter(|p| !role_perms.contains(p))
        .cloned()
        .collect();

    if missing.is_empty() {
        AccessDecision {
            allowed: true,
            reason: None,
            required_permissions: permissions.to_vec(),
        }
    } else {
        AccessDecision {
            allowed: false,
            reason: Some(format!(
                "专家 {} 缺少以下权限: {:?}",
                expert_id, missing
            )),
            required_permissions: permissions.to_vec(),
        }
    }
}
