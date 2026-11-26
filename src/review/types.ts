export interface DiffRow {
  mark: "+" | "-" | " ";
  line: number;
  text: string;
}

export interface CommentTarget {
  path: string;
  mark: DiffRow["mark"];
  line: number;
  endMark: DiffRow["mark"];
  endLine: number;
  rows: DiffRow[];
}

export interface ReviewComment extends CommentTarget {
  text: string;
}
