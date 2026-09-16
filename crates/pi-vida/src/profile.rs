use serde_yaml::Value;

/// A parsed vida profile: the allowlist (INV-3). `vida:`/`life:` keys are
/// validated (both set and differing exits 2, either alone or neither is
/// valid when the rest parses) but not stored — the CLI argument plus
/// filename aliases determine the launched vida (INV-3).
#[derive(Debug, PartialEq)]
pub struct Profile {
    pub mantra: Vec<String>,
    pub packs: Vec<String>,
    pub tracker: Option<String>,
}

fn as_list(key: &str, v: Option<&Value>) -> Result<Vec<String>, String> {
    let Some(v) = v else { return Ok(vec![]) };
    match v {
        Value::Null => Ok(vec![]),
        Value::String(s) => Ok(if s.is_empty() { vec![] } else { vec![s.clone()] }),
        Value::Sequence(items) => {
            let mut out = vec![];
            for item in items {
                match item {
                    Value::String(s) if !s.is_empty() => out.push(s.clone()),
                    Value::String(_) => {}
                    _ => return Err(format!("{key} must be a string or list of strings")),
                }
            }
            Ok(out)
        }
        _ => Err(format!("{key} must be a string or list of strings")),
    }
}

fn as_name(key: &str, v: Option<&Value>) -> Result<Option<String>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

/// Parse a profile YAML strictly (INV-3 / AC-12 / AC-15). Malformed YAML or
/// a schema violation is an Err the caller maps to exit 2.
pub fn parse_profile(text: &str) -> Result<Profile, String> {
    let doc: Value =
        serde_yaml::from_str(text).map_err(|e| format!("invalid profile YAML: {e}"))?;
    let Value::Mapping(map) = &doc else {
        return Err("invalid profile YAML: expected a mapping".into());
    };
    let get = |k: &str| map.get(Value::String(k.into()));
    let vida = as_name("vida", get("vida"))?;
    let life = as_name("life", get("life"))?;
    if let (Some(v), Some(l)) = (&vida, &life) {
        if v != l {
            return Err("invalid profile YAML: vida and life both set and differ".into());
        }
    }
    let mantra = as_list("mantra", get("mantra"))?;
    let packs = as_list("packs", get("packs"))?;
    let tracker = as_list("tracker", get("tracker"))?;
    if tracker.len() > 1 {
        return Err("tracker must be a single value or \"none\"".into());
    }
    // models:/thinking: must be mappings when present (light check; full
    // role/level validation stays in the bash launch path).
    for key in ["models", "thinking"] {
        if let Some(v) = get(key) {
            if !matches!(v, Value::Mapping(_) | Value::Null) {
                return Err(format!("{key} must be a mapping"));
            }
        }
    }
    let tracker = tracker.into_iter().find(|t| t != "none");
    Ok(Profile {
        mantra,
        packs,
        tracker,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vida_only_launches() {
        let p = parse_profile("vida: ruby\ntracker: github-issue\npacks: [a]\nmantra: [m]\n").unwrap();
        assert_eq!(p.mantra, vec!["m"]);
        assert_eq!(p.packs, vec!["a"]);
        assert_eq!(p.tracker.as_deref(), Some("github-issue"));
    }

    #[test]
    fn life_only_launches() {
        let p = parse_profile("life: python\ntracker: none\npacks: []\nmantra: [i-have-adhd]\n").unwrap();
        assert_eq!(p.tracker, None);
    }

    #[test]
    fn neither_key_launches_when_mapping_parses() {
        parse_profile("tracker: none\npacks: []\nmantra: [i-have-adhd]\n").unwrap();
    }

    #[test]
    fn both_keys_equal_launch() {
        parse_profile("vida: ruby\nlife: ruby\npacks: []\nmantra: []\n").unwrap();
    }

    #[test]
    fn both_keys_different_exit_two() {
        let err = parse_profile("vida: python\nlife: ruby\npacks: []\nmantra: []\n").unwrap_err();
        assert!(err.contains("vida and life both set and differ"));
    }

    #[test]
    fn mantra_as_scalar_string() {
        let p = parse_profile("mantra: solo\n").unwrap();
        assert_eq!(p.mantra, vec!["solo"]);
    }

    #[test]
    fn tracker_none_is_sentinel() {
        let p = parse_profile("tracker: none\n").unwrap();
        assert_eq!(p.tracker, None);
    }

    #[test]
    fn invalid_yaml_is_err() {
        let err = parse_profile(":\n  [\n").unwrap_err();
        assert!(err.starts_with("invalid profile YAML"));
        let err = parse_profile("- a\n- b\n").unwrap_err();
        assert!(err.contains("expected a mapping"));
    }

    #[test]
    fn bad_list_types_are_err() {
        let err = parse_profile("packs: {bad: true}\n").unwrap_err();
        assert!(err.contains("must be a string or list of strings"));
        let err = parse_profile("mantra: [1]\n").unwrap_err();
        assert!(err.contains("must be a string or list of strings"));
        let err = parse_profile("vida: 7\n").unwrap_err();
        assert!(err.contains("must be a string"));
    }

    #[test]
    fn models_non_mapping_is_err() {
        let err = parse_profile("models: solo\n").unwrap_err();
        assert!(err.contains("models must be a mapping"));
    }

    #[test]
    fn omitted_or_null_fields_default() {
        let p = parse_profile("vida: ruby\n").unwrap();
        assert_eq!(p.mantra, Vec::<String>::new());
        assert_eq!(p.packs, Vec::<String>::new());
        assert_eq!(p.tracker, None);
    }
}
