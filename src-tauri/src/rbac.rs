// ========== RBAC 权限控制系统 ==========
// 基于专家角色的权限模型

use crate::expert_identity::{
    is_creative_expert, is_documentation_expert, is_implementation_expert, is_review_expert,
    is_supervisor_expert, normalize_expert_id,
};
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
    Supervisor,   // 主管：全部权限
    LeadEngineer, // 主工程师：读写文件、执行代码、访问记忆
    Engineer,     // 工程师：读写文件、访问记忆
    Reviewer,     // 审查员：读文件、访问记忆
    Researcher,   // 调研员：读文件、访问记忆、调用外部API
    Designer,     // 设计师：读文件、写设计相关文件
    Assistant,    // 助手：访问记忆、读文件
}

impl Role {
    /// 获取角色对应的权限列表
    pub fn permissions(&self) -> Vec<Permission> {
        let shared_expert_permissions = vec![
            Permission::ReadFiles,
            Permission::WriteFiles,
            Permission::ExecuteCode,
            Permission::CallExternalApi,
            Permission::AccessMemory,
            Permission::ModifyMemory,
        ];
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
            Role::LeadEngineer
            | Role::Engineer
            | Role::Reviewer
            | Role::Researcher
            | Role::Designer
            | Role::Assistant => shared_expert_permissions,
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
    let expert_id = normalize_expert_id(expert_id);
    let expert_id = expert_id.as_ref();
    if is_implementation_expert(expert_id) || expert_id == "discipline-910" {
        return Role::Engineer;
    }
    if is_review_expert(expert_id) {
        return Role::Reviewer;
    }
    if is_creative_expert(expert_id) {
        return Role::Designer;
    }
    if is_documentation_expert(expert_id) || expert_id == "jiang-xinghe" {
        return Role::Assistant;
    }
    if expert_id.starts_with("discipline-") {
        return Role::Researcher;
    }
    match expert_id {
        "jiang-xingtu" => Role::Supervisor,
        "jiang-xinghe" => Role::Assistant,
        _ => Role::Researcher,
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
        ".env",
        ".ssh",
        "id_rsa",
        "id_dsa",
        ".p12",
        ".pem",
        "credentials",
        "secret",
        "password",
        "token",
        ".git/config",
        ".git/credentials",
    ];

    let lower_path = path.to_lowercase();
    for sensitive in &sensitive_paths {
        if lower_path.contains(sensitive) {
            // 敏感路径只允许主管访问
            let role = get_default_role(expert_id);
            if is_supervisor_expert(expert_id) {
                return AccessDecision {
                    allowed: true,
                    reason: Some(format!("敏感路径访问已授权（{:?}角色）", role)),
                    required_permissions: vec![Permission::ReadFiles],
                };
            }
            return AccessDecision {
                allowed: false,
                reason: Some(format!("专家 {} 无权访问敏感路径 {}", expert_id, path)),
                required_permissions: vec![Permission::ReadFiles],
            };
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
            reason: Some(format!("专家 {} 缺少以下权限: {:?}", expert_id, missing)),
            required_permissions: permissions.to_vec(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{get_default_role, Permission, Role};

    #[test]
    fn non_supervisor_roles_share_same_permission_set() {
        let engineer = Role::Engineer.permissions();
        let reviewer = Role::Reviewer.permissions();
        let researcher = Role::Researcher.permissions();
        let designer = Role::Designer.permissions();
        let assistant = Role::Assistant.permissions();

        assert_eq!(engineer, reviewer);
        assert_eq!(engineer, researcher);
        assert_eq!(engineer, designer);
        assert_eq!(engineer, assistant);
        assert!(engineer.contains(&Permission::CallExternalApi));
        assert!(engineer.contains(&Permission::ExecuteCode));
        assert!(engineer.contains(&Permission::ModifyMemory));
    }

    #[test]
    fn legacy_ids_follow_discipline_role_mapping() {
        assert!(matches!(get_default_role("jiang-yumo"), Role::Engineer));
        assert!(matches!(get_default_role("jiang-yingqiu"), Role::Reviewer));
        assert!(matches!(get_default_role("jiang-ruoxi"), Role::Researcher));
        assert!(matches!(get_default_role("jiang-xinghe"), Role::Assistant));
    }

    #[test]
    fn environment_engineering_discipline_maps_to_engineer_role() {
        assert!(matches!(get_default_role("discipline-610"), Role::Engineer));
    }
}
