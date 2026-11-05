import { Link, useNavigate } from "react-router-dom";

import { useForm } from "react-hook-form";
import { api } from "@/shared/lib/api";

export function ProjectCreatePage() {
  const navigate = useNavigate();
  const form = useForm({ defaultValues: { id: "", name: "" } });
  const submit = async (values: { id: string; name: string }) => {
    const result = await api<{ project: { id: string } }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(values),
    });
    window.localStorage.setItem(
      "research-workbench-project",
      result.project.id,
    );
    navigate("/agents");
  };
  return (
    <section className="page page--create">
      <div className="page-head page-head--narrow">
        <div>
          <h1>创建研究项目</h1>
        </div>
      </div>
      <form className="create-form" onSubmit={form.handleSubmit(submit)}>
        <label>
          <span>项目 ID <i aria-hidden="true">*</i></span>
          <input
            {...form.register("id", { required: true })}
            placeholder="请输入项目 ID"
            required
          />
        </label>
        <label>
          <span>项目名称 <i aria-hidden="true">*</i></span>
          <input
            {...form.register("name", { required: true })}
            placeholder="请输入项目名称"
            required
          />
        </label>
        <div className="form-actions">
          <button className="button primary" type="submit">
            创建项目
          </button>
          <Link className="button" to="/projects">
            取消
          </Link>
        </div>
      </form>
    </section>
  );
}
