//! Un petit lecteur de JSON, pour les catalogues (content/catalog.json) : pas de dépendance, et des
//! nombres lus au bit près. Le catalogue est écrit par `JSON.stringify`, qui écrit le plus court
//! texte qui redonne le même nombre ; `str::parse::<f64>` arrondit correctement, comme `JSON.parse` :
//! on relit exactement les nombres du TypeScript (serde_json, lui, n'arrondit correctement qu'avec
//! sa fonctionnalité `float_roundtrip`).

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    /// Les clés dans l'ordre du fichier.
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn parse(text: &str) -> Result<Json, String> {
        let mut r = Reader { s: text.as_bytes(), i: 0 };
        let value = r.value()?;
        r.blank();
        if r.i != r.s.len() {
            return Err(format!("JSON : texte en trop à l'octet {}", r.i));
        }
        Ok(value)
    }

    /// Le champ `key` d'un objet.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn num(&self) -> Option<f64> {
        match self {
            Json::Num(n) => Some(*n),
            _ => None,
        }
    }

    pub fn str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn arr(&self) -> &[Json] {
        match self {
            Json::Arr(a) => a,
            _ => &[],
        }
    }

    pub fn fields(&self) -> &[(String, Json)] {
        match self {
            Json::Obj(f) => f,
            _ => &[],
        }
    }

    pub fn is_true(&self) -> bool {
        matches!(self, Json::Bool(true))
    }
}

struct Reader<'a> {
    s: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn blank(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn error<T>(&self, what: &str) -> Result<T, String> {
        Err(format!("JSON : {what} à l'octet {}", self.i))
    }

    fn value(&mut self) -> Result<Json, String> {
        self.blank();
        match self.s.get(self.i) {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') => self.word("true", Json::Bool(true)),
            Some(b'f') => self.word("false", Json::Bool(false)),
            Some(b'n') => self.word("null", Json::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => self.error("valeur attendue"),
        }
    }

    fn word(&mut self, word: &str, value: Json) -> Result<Json, String> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(value)
        } else {
            self.error("mot inconnu")
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.i;
        while self.i < self.s.len() && matches!(self.s[self.i], b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9') {
            self.i += 1;
        }
        let text = std::str::from_utf8(&self.s[start..self.i]).map_err(|e| e.to_string())?;
        text.parse::<f64>().map(Json::Num).map_err(|_| format!("JSON : nombre illisible « {text} »"))
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self.s.get(self.i..self.i + 4).ok_or("JSON : \\u tronqué")?;
        let text = std::str::from_utf8(digits).map_err(|e| e.to_string())?;
        self.i += 4;
        u32::from_str_radix(text, 16).map_err(|_| "JSON : \\u illisible".to_string())
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1; // le guillemet
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len() && self.s[self.i] != b'"' && self.s[self.i] != b'\\' {
                self.i += 1;
            }
            out.push_str(std::str::from_utf8(&self.s[start..self.i]).map_err(|e| e.to_string())?);
            match self.s.get(self.i) {
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    let escape = *self.s.get(self.i + 1).ok_or("JSON : échappement tronqué")?;
                    self.i += 2;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let mut code = self.hex4()?;
                            // Une paire de substitution (UTF-16)
                            if (0xd800..0xdc00).contains(&code) && self.s[self.i..].starts_with(b"\\u") {
                                self.i += 2;
                                let low = self.hex4()?;
                                code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
                            }
                            out.push(char::from_u32(code).unwrap_or('\u{fffd}'));
                        }
                        _ => return self.error("échappement inconnu"),
                    }
                }
                _ => return self.error("chaîne non fermée"),
            }
        }
    }

    fn array(&mut self) -> Result<Json, String> {
        self.i += 1;
        let mut items = Vec::new();
        self.blank();
        if self.s.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.value()?);
            self.blank();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return self.error("« , » ou « ] » attendu"),
            }
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.i += 1;
        let mut fields = Vec::new();
        self.blank();
        if self.s.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(Json::Obj(fields));
        }
        loop {
            self.blank();
            if self.s.get(self.i) != Some(&b'"') {
                return self.error("clé attendue");
            }
            let key = self.string()?;
            self.blank();
            if self.s.get(self.i) != Some(&b':') {
                return self.error("« : » attendu");
            }
            self.i += 1;
            fields.push((key, self.value()?));
            self.blank();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Json::Obj(fields));
                }
                _ => return self.error("« , » ou « } » attendu"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lit_les_valeurs() {
        let j = Json::parse(r#" { "a": [1, -2.5e-3, true, null], "b": "éé\"😀", "c": {} } "#).unwrap();
        assert_eq!(j.get("a").unwrap().arr()[1].num(), Some(-2.5e-3));
        assert_eq!(j.get("b").unwrap().str(), Some("éé\"😀"));
        assert!(j.get("a").unwrap().arr()[2].is_true());
        assert!(Json::parse("[1,]").is_err());
    }

    #[test]
    fn nombres_au_bit_pres() {
        for x in [0.1f64, 0.30000000000000004, 1.0 / 3.0, 9.81, 5e-324, 1.7976931348623157e308] {
            let text = format!("[{x:?}]");
            assert_eq!(Json::parse(&text).unwrap().arr()[0].num().unwrap().to_bits(), x.to_bits());
        }
    }
}
